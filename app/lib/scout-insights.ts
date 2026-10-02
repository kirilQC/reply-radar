// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Scout's "insight" tools: each one answers a question the team asks every week in ONE call, with exact
 * numbers, instead of leaving the model to stitch ten lookups together and count rows by eye.
 *
 * Written after a 25-question audit of Scout (2026-10-02). The weak answers all had the same cause: no
 * tool gave the number that was asked for, so the model approximated ("100+ vs 100+", "counting
 * through… ~98"), or used the wrong source ("no client is missing a messaging doc", from the brain, when
 * the doc link lives on the workspace). Each tool here owns one of those questions:
 *
 *   client_scorecard     how is X doing / compare X and Y / who dropped, for any date range, with deltas
 *   follow_up_list       who needs following up: awaiting us, went quiet, sent a booking link but no meeting
 *   client_readiness     what each client is missing: messaging doc, brain docs, brief, onboarding, setup
 *   messaging_performance which connection requests and openers work, ranked with their volume
 *   google_doc           read a Google Doc or Sheet (or a client's messaging doc) by link
 */

import { campaignStatusFor, ALL_STATUSES } from "./heyreach-campaigns";
import { dailyStatsFor } from "./heyreach-campaign-metrics";
import { fetchMessagingTabs, googleDocsConfigured } from "./google-docs";
import { brainConfigured, brainTree } from "./brain";
import { brainFolderFor } from "../../shared/brain-link.mjs";
import { clientsIn, clientSkeleton } from "../../shared/brain-structure.mjs";
import { ourCampaigns } from "../../shared/campaign-code.mjs";
import { sendingDaysLeft } from "../../shared/sending-runway.mjs";
import { listOnboardingClients } from "./onboarding";

type Row = Record<string, unknown>;
type ToolDefinition = { name: string; description: string; input_schema: { type: "object"; properties: Row; required?: string[] } };

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : "");
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const strings = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map(text).filter(Boolean);

function supabase() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}
async function db(path: string): Promise<Row[]> {
  const { url, key } = supabase();
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  if (!r.ok) throw new Error(`Database ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  const body = await r.json().catch(() => []);
  return Array.isArray(body) ? (body as Row[]) : [];
}
/** Every row, 1,000 at a time (Supabase caps a response at 1,000). `path` must carry an order. */
async function dbAll(path: string, cap = 60_000): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; offset < cap; offset += 1000) {
    const page = await db(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${offset}`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}
/** Rows for a long id list, 60 ids per request so the URL stays short. */
async function dbByIds(build: (ids: string[]) => string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  const unique = [...new Set(ids.filter(Boolean))];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += 60) batches.push(unique.slice(i, i + 60));
  for (let i = 0; i < batches.length; i += 6) {
    const pages = await Promise.all(batches.slice(i, i + 6).map((b) => dbAll(build(b))));
    pages.forEach((p) => out.push(...p));
  }
  return out;
}

type Client = { id: string; name: string; slug: string; apiKey: string; guardrails: Row; brief: string; brainFolder: string; internal: string; external: string; granola: string; airtable: string; morningBrief: boolean };
async function allClients(): Promise<Client[]> {
  const rows = await db("rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext,guardrails,client_brief,brain_folder,slack_internal_channel_id,slack_external_channel_id,granola_title_match,airtable_base_id,morning_brief_enabled&slug=neq.misc&order=name.asc");
  return rows.filter((r) => text(r.name)).map((r) => ({
    id: text(r.id), name: text(r.name), slug: text(r.slug), apiKey: text(r.heyreach_api_key_ciphertext),
    guardrails: (r.guardrails && typeof r.guardrails === "object" ? r.guardrails : {}) as Row,
    brief: text(r.client_brief), brainFolder: text(r.brain_folder), internal: text(r.slack_internal_channel_id), external: text(r.slack_external_channel_id),
    granola: text(r.granola_title_match), airtable: text(r.airtable_base_id), morningBrief: Boolean(r.morning_brief_enabled),
  }));
}
function pickClients(all: Client[], wanted: string[]): Client[] {
  if (!wanted.length) return all;
  return wanted.map((w) => {
    const q = w.toLowerCase();
    const hit = all.find((c) => c.slug.toLowerCase() === q || c.name.toLowerCase() === q) ?? all.filter((c) => c.name.toLowerCase().includes(q) || c.slug.toLowerCase().includes(q))[0];
    if (!hit) throw new Error(`There is no client called "${w}". The clients are: ${all.map((c) => c.name).join(", ")}.`);
    return hit;
  });
}

/* ── Dates ─────────────────────────────────────────────────────────────────────────────────────── */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
function windowOf(fromRaw: unknown, toRaw: unknown, fallbackDays = 30): { from: string; to: string; days: number } {
  const today = new Date();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(text(toRaw)) ? text(toRaw) : isoDay(today);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(text(fromRaw)) ? text(fromRaw) : isoDay(new Date(Date.parse(`${to}T12:00:00Z`) - (fallbackDays - 1) * 86_400_000));
  const days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1);
  return { from, to, days };
}
const previousWindow = (w: { from: string; days: number }) => {
  const to = isoDay(new Date(Date.parse(`${w.from}T12:00:00Z`) - 86_400_000));
  return { from: isoDay(new Date(Date.parse(`${to}T12:00:00Z`) - (w.days - 1) * 86_400_000)), to, days: w.days };
};
const endExclusive = (to: string) => isoDay(new Date(Date.parse(`${to}T12:00:00Z`) + 86_400_000));

/* ── client_scorecard ──────────────────────────────────────────────────────────────────────────── */

type Window = { from: string; to: string; days: number };
/** Replies (people), positive replies and meetings from QC Command's own database, per client, in a window. */
async function dbWindowStats(clients: Client[], w: Window) {
  const byId = new Map(clients.map((c) => [c.id, c]));
  const inbound = await dbAll(`rr_messages?select=conversation_id,sent_at,sentiment:raw_data->reply_radar->>sentiment&direction=eq.inbound&sent_at=gte.${w.from}&sent_at=lt.${endExclusive(w.to)}&order=sent_at.asc`);
  const convIds = [...new Set(inbound.map((m) => text(m.conversation_id)))];
  const convs = await dbByIds((ids) => `rr_conversations?select=id,workspace_id&id=in.(${ids.join(",")})&order=id.asc`, convIds);
  const wsOf = new Map(convs.map((c) => [text(c.id), text(c.workspace_id)]));
  const stats = new Map<string, { replied: Set<string>; positive: Set<string>; negative: Set<string>; messages: number }>();
  for (const c of clients) stats.set(c.id, { replied: new Set(), positive: new Set(), negative: new Set(), messages: 0 });
  // Latest sentiment per conversation inside the window decides how that person's reply reads.
  const lastSentiment = new Map<string, string>();
  for (const m of inbound) {
    const conv = text(m.conversation_id); const ws = wsOf.get(conv); if (!ws || !byId.has(ws)) continue;
    const s = stats.get(ws)!; s.replied.add(conv); s.messages += 1;
    const sent = text(m.sentiment).toLowerCase(); if (sent) lastSentiment.set(conv, sent);
  }
  for (const [conv, sent] of lastSentiment) { const ws = wsOf.get(conv); const s = ws ? stats.get(ws) : null; if (!s) continue; if (sent === "positive") s.positive.add(conv); if (sent === "negative") s.negative.add(conv); }
  const meetings = await dbAll(`rr_meetings?select=workspace_id,created_at,meeting_at,status&created_at=gte.${w.from}&created_at=lt.${endExclusive(w.to)}&order=created_at.asc`);
  const booked = new Map<string, number>();
  for (const m of meetings) { const ws = text(m.workspace_id); if (byId.has(ws) && !/cancel/i.test(text(m.status))) booked.set(ws, (booked.get(ws) ?? 0) + 1); }
  return new Map(clients.map((c) => { const s = stats.get(c.id)!; return [c.id, { peopleReplied: s.replied.size, positive: s.positive.size, negative: s.negative.size, replyMessages: s.messages, meetingsBooked: booked.get(c.id) ?? 0 }]; }));
}
/** Connection requests sent/accepted and HeyReach-counted replies, per client, in a window. Stored copy first, live for the gaps. */
async function sendingStats(clients: Client[], w: Window, live: boolean) {
  const stored = await dbAll(`rr_daily_stats?select=workspace_id,day,connections_sent,connections_accepted,replies&sender_id=eq.&day=gte.${w.from}&day=lte.${w.to}&order=day.asc`);
  const out = new Map<string, { sent: number; accepted: number; heyreachReplies: number; source: string }>();
  for (const c of clients) {
    const days = stored.filter((r) => text(r.workspace_id) === c.id);
    out.set(c.id, { sent: days.reduce((a, r) => a + num(r.connections_sent), 0), accepted: days.reduce((a, r) => a + num(r.connections_accepted), 0), heyreachReplies: days.reduce((a, r) => a + num(r.replies), 0), source: days.length ? `stored daily stats (${days.length} days)` : "none stored" });
  }
  // The stored copy keeps a recent window only. For an older or longer range, ask HeyReach directly
  // (two calls per client), which is why it's capped to a handful of clients.
  const oldestStored = stored.length ? text(stored[0].day) : "";
  const needLive = live && (!oldestStored || oldestStored > w.from);
  if (needLive) {
    await Promise.all(clients.filter((c) => c.apiKey).map(async (c) => {
      try {
        const status = await campaignStatusFor(c.apiKey, ALL_STATUSES);
        const ids = status.all.map((r) => r.id).filter(Boolean);
        if (!ids.length) return;
        const days = await dailyStatsFor(c.apiKey, ids, `${w.from}T00:00:00.000Z`, `${endExclusive(w.to)}T00:00:00.000Z`);
        if (!days) return;
        out.set(c.id, { sent: days.reduce((a, d) => a + d.sent, 0), accepted: days.reduce((a, d) => a + d.accepted, 0), heyreachReplies: days.reduce((a, d) => a + d.replies, 0), source: "HeyReach live" });
      } catch { /* keep the stored figures */ }
    }));
  }
  return out;
}
async function runway(c: Client) {
  if (!c.apiKey) return null;
  try {
    const status = await campaignStatusFor(c.apiKey, ALL_STATUSES);
    const active = status.all.filter((r) => r.state === "active");
    const pending = active.reduce((a, r) => a + num(r.progress.pending), 0);
    const senderIds = new Set<string>(); let senders = 0;
    for (const r of active) { senders += r.senders; for (const n of (r as unknown as { senderNames?: string[] }).senderNames ?? []) senderIds.add(n); }
    const senderCount = Math.max(senderIds.size, active.reduce((m, r) => Math.max(m, r.senders), 0));
    return { activeCampaigns: active.map((r) => ({ name: r.name, pending: num(r.progress.pending), senders: r.senders })), leadsPending: pending, daysOfSendingLeft: sendingDaysLeft(pending, senderCount || senders) };
  } catch { return null; }
}

async function clientScorecard(input: Row) {
  const all = await allClients();
  const picked = pickClients(all, strings(input.clients ?? input.client));
  const w = windowOf(input.from, input.to, 30);
  const prev = previousWindow(w);
  const live = picked.length <= 8;
  const [cur, before, sendCur, sendPrev] = await Promise.all([
    dbWindowStats(picked, w), dbWindowStats(picked, prev), sendingStats(picked, w, live), sendingStats(picked, prev, live),
  ]);
  const runways = live ? await Promise.all(picked.map(runway)) : picked.map(() => null);
  const delta = (a: number, b: number) => ({ now: a, before: b, change: a - b, changePct: b > 0 ? Math.round(((a - b) / b) * 100) : null });
  const rows = picked.map((c, i) => {
    const d = cur.get(c.id)!, p = before.get(c.id)!, s = sendCur.get(c.id)!, sp = sendPrev.get(c.id)!;
    return {
      client: c.name,
      requestsSent: delta(s.sent, sp.sent),
      accepted: delta(s.accepted, sp.accepted),
      acceptanceRatePct: { now: pct(s.accepted, s.sent), before: pct(sp.accepted, sp.sent) },
      peopleReplied: delta(d.peopleReplied, p.peopleReplied),
      replyRateOfAcceptedPct: { now: pct(d.peopleReplied, s.accepted), before: pct(p.peopleReplied, sp.accepted) },
      positiveReplies: delta(d.positive, p.positive),
      positiveShareOfRepliesPct: { now: pct(d.positive, d.peopleReplied), before: pct(p.positive, p.peopleReplied) },
      negativeReplies: d.negative,
      meetingsBooked: delta(d.meetingsBooked, p.meetingsBooked),
      sendingSource: s.source,
      ...(runways[i] ? { live: runways[i] } : {}),
    };
  });
  return {
    window: w, previousWindow: prev,
    definitions: "peopleReplied = distinct people who sent at least one message in the window (QC Command database). replyRateOfAcceptedPct = peopleReplied / accepted connection requests in the same window. acceptanceRatePct = accepted / sent. positiveReplies = people whose latest reply in the window was judged positive. meetingsBooked = meetings recorded in the window. Every figure has a matching 'before' for the previous period of the same length.",
    note: live ? "Live HeyReach runway included (active campaigns, leads pending, days of sending left)." : "More than 8 clients: runway left out to keep this fast. Ask for specific clients to include it.",
    clients: rows,
  };
}

/* ── follow_up_list ────────────────────────────────────────────────────────────────────────────── */

const BOOKING_LINK = /(calendly\.com|cal\.com\/|savvycal\.com|tidycal\.com|zcal\.co|hubspot\.com\/meetings|meetings\.hubspot\.com|chilipiper\.com|youcanbook\.me|calendar\.app\.google|calendar\.google\.com\/calendar\/appointments|book a (time|call|slot)|grab a time|booking link)/i;
const slugOf = (url: string) => (/linkedin\.com\/in\/([^/?#]+)/i.exec(url)?.[1] ?? "").toLowerCase();
const normName = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();

async function followUpList(input: Row) {
  const all = await allClients();
  const picked = text(input.client) ? pickClients(all, [text(input.client)]) : all;
  const staleDays = Math.max(1, Math.min(60, num(input.staleDays) || 3));
  const includeNegative = input.includeNegative === true;
  const wantCategories = strings(input.category ?? input.categories).map((c) => c.toLowerCase());
  // Threads older than this are dead in practice; they're counted, not listed, unless asked for.
  const maxDays = Math.max(7, Math.min(3650, num(input.maxDaysSince) || 90));
  let olderSkipped = 0;
  const byId = new Map(picked.map((c) => [c.id, c]));
  const convs = await dbAll(`rr_conversations?select=id,lead_id,workspace_id,last_message_at,last_message_direction${picked.length === all.length ? "" : `&workspace_id=in.(${picked.map((c) => c.id).join(",")})`}&order=id.asc`);
  const convIds = convs.map((c) => text(c.id));
  const [messages, leads, meetings] = await Promise.all([
    dbByIds((ids) => `rr_messages?select=conversation_id,direction,sent_at,body,sentiment:raw_data->reply_radar->>sentiment,urgency:raw_data->reply_radar->>followup_urgency&conversation_id=in.(${ids.join(",")})&order=sent_at.asc`, convIds),
    dbByIds((ids) => `rr_leads?select=id,name,role,company,linkedin_profile_url&id=in.(${ids.join(",")})&order=id.asc`, convs.map((c) => text(c.lead_id))),
    dbAll(`rr_meetings?select=workspace_id,invitee_name,invitee_linkedin,meeting_at,created_at,status&order=created_at.asc`),
  ]);
  const leadById = new Map(leads.map((l) => [text(l.id), l]));
  const msgsByConv = new Map<string, Row[]>();
  for (const m of messages) { const k = text(m.conversation_id); (msgsByConv.get(k) ?? msgsByConv.set(k, []).get(k)!).push(m); }
  const bookedSlugs = new Set<string>(), bookedNames = new Set<string>();
  for (const m of meetings) { if (/cancel/i.test(text(m.status))) continue; const s = slugOf(text(m.invitee_linkedin)); if (s) bookedSlugs.add(s); const n = normName(text(m.invitee_name)); if (n) bookedNames.add(`${text(m.workspace_id)}|${n}`); }
  const now = Date.now();
  const out: Row[] = [];
  const counts = { theyRepliedWeHavent: 0, wentQuietAfterOurReply: 0, sentBookingLinkNoMeeting: 0 };
  for (const c of convs) {
    const client = byId.get(text(c.workspace_id)); if (!client) continue;
    const msgs = msgsByConv.get(text(c.id)) ?? []; if (!msgs.length) continue;
    const inbound = msgs.filter((m) => text(m.direction) === "inbound");
    if (!inbound.length) continue; // never replied: a campaign follow-up, not a conversation to chase
    const outbound = msgs.filter((m) => text(m.direction) !== "inbound");
    const last = msgs[msgs.length - 1];
    const lastInbound = inbound[inbound.length - 1];
    const sentiment = text(lastInbound.sentiment).toLowerCase() || null;
    if (sentiment === "negative" && !includeNegative) continue;
    const lead = leadById.get(text(c.lead_id)) ?? {};
    const booked = bookedSlugs.has(slugOf(text(lead.linkedin_profile_url))) || bookedNames.has(`${client.id}|${normName(text(lead.name))}`);
    const linkMsg = outbound.find((m) => BOOKING_LINK.test(text(m.body)));
    const ourReplyAfterTheirs = outbound.filter((m) => text(m.sent_at) > text(inbound[0].sent_at));
    const daysSinceLast = Math.floor((now - Date.parse(text(last.sent_at))) / 86_400_000);
    let category = "";
    if (text(last.direction) === "inbound") category = "they_replied_we_havent";
    else if (linkMsg && !booked && text(linkMsg.sent_at) > text(lastInbound.sent_at)) category = daysSinceLast >= staleDays ? "sent_booking_link_no_meeting" : "";
    else if (ourReplyAfterTheirs.length && !booked && daysSinceLast >= staleDays) category = "went_quiet_after_our_reply";
    if (linkMsg && !booked && !category && daysSinceLast >= staleDays) category = "sent_booking_link_no_meeting";
    if (!category) continue;
    if (daysSinceLast > maxDays) { olderSkipped += 1; continue; }
    if (wantCategories.length && !wantCategories.includes(category)) continue;
    if (category === "they_replied_we_havent") counts.theyRepliedWeHavent += 1;
    if (category === "went_quiet_after_our_reply") counts.wentQuietAfterOurReply += 1;
    if (category === "sent_booking_link_no_meeting") counts.sentBookingLinkNoMeeting += 1;
    out.push({
      category,
      name: text(lead.name), title: text(lead.role), company: text(lead.company), client: client.name,
      daysSinceLastMessage: daysSinceLast, lastMessageFrom: text(last.direction) === "inbound" ? "lead" : "us",
      lastMessage: text(last.body).replace(/\s+/g, " ").slice(0, 220),
      sentiment, followUpUrgency: text(lastInbound.urgency) ? num(lastInbound.urgency) : null,
      bookingLinkSent: Boolean(linkMsg), meetingBooked: booked,
      linkedin: text(lead.linkedin_profile_url),
    });
  }
  const order: Record<string, number> = { they_replied_we_havent: 0, sent_booking_link_no_meeting: 1, went_quiet_after_our_reply: 2 };
  out.sort((a, b) => order[text(a.category)] - order[text(b.category)] || num(b.followUpUrgency) - num(a.followUpUrgency) || num(a.daysSinceLastMessage) - num(b.daysSinceLastMessage));
  return {
    scope: picked.length === all.length ? "all clients" : picked.map((c) => c.name).join(", "),
    staleDays, maxDaysSince: maxDays, olderThanWindowNotListed: olderSkipped,
    ...(wantCategories.length ? { onlyCategories: wantCategories } : {}),
    definitions: "they_replied_we_havent: the lead sent the last message. sent_booking_link_no_meeting: we sent a booking link (Calendly etc.) after their last reply, no meeting is recorded for them, and it has been at least staleDays. went_quiet_after_our_reply: they replied at some point, we answered, they went silent for at least staleDays and have no meeting. Negative leads are excluded unless includeNegative. Meetings are matched by LinkedIn profile or name against the Meetings tab.",
    counts: { total: out.length, ...counts, ofThoseNotBooked: out.filter((r) => !r.meetingBooked).length },
    leads: out,
  };
}

/* ── client_readiness ──────────────────────────────────────────────────────────────────────────── */

async function clientReadiness(input: Row) {
  const all = await allClients();
  const picked = text(input.client) ? pickClients(all, [text(input.client)]) : all;
  const [tree, onboarding] = await Promise.all([
    brainConfigured() ? brainTree().catch(() => []) : Promise.resolve([]),
    listOnboardingClients().catch(() => []),
  ]);
  const paths = tree.map((f) => f.path);
  const sizeOf = new Map(tree.map((f) => [f.path, f.size]));
  const folders = clientsIn(paths);
  const PLACEHOLDER_BYTES = 700;
  const rows = picked.map((c) => {
    const { folder } = brainFolderFor({ slug: c.slug, name: c.name, brainFolder: c.brainFolder || null }, folders) as { folder: string };
    const docs: Row = {};
    if (folder) {
      const sk = clientSkeleton(folder, paths) as { docs: Array<{ key: string; label: string; found: string }> };
      for (const d of sk.docs) docs[d.label] = d.found ? ((sizeOf.get(d.found) ?? 0) < PLACEHOLDER_BYTES ? "placeholder (nearly empty)" : "written") : "missing";
    }
    const ob = onboarding.find((o) => o.slug === c.slug || o.id === c.id);
    const messagingDoc = text(c.guardrails.messaging_doc_url);
    const missing: string[] = [];
    if (!messagingDoc) missing.push("messaging doc link");
    if (!folder) missing.push("QC Brain folder");
    else for (const [k, v] of Object.entries(docs)) if (["ICP", "Personas", "Voice", "Brief"].includes(k) && v !== "written") missing.push(`brain ${k} (${v})`);
    if (c.brief.length < 80) missing.push("client brief in QC Command");
    if (!c.apiKey) missing.push("HeyReach key");
    if (!c.internal) missing.push("internal Slack channel");
    if (ob && !ob.progress.complete) missing.push(`onboarding ${ob.progress.pct}% done (${ob.progress.doneLeaves}/${ob.progress.totalLeaves} steps)`);
    return {
      client: c.name, missing,
      messagingDoc: messagingDoc ? "set" : "missing",
      brainFolder: folder || "none found", brainDocs: docs,
      clientBrief: c.brief.length >= 80 ? "saved" : c.brief ? "too short to be useful" : "missing",
      onboarding: ob ? `${ob.progress.pct}% (${ob.progress.doneLeaves}/${ob.progress.totalLeaves})` : "not started",
      heyreach: c.apiKey ? "connected" : "missing", slackInternal: c.internal ? "set" : "missing", slackExternal: c.external ? "set" : "missing",
      granolaCalls: c.granola ? `matches "${c.granola}"` : "matches the client name", airtable: c.airtable ? "linked" : "not linked", morningBrief: c.morningBrief ? "on" : "off",
    };
  });
  return {
    note: "The messaging doc is a link saved on the client in QC Command (Configuration), not a brain file. Brain docs under 700 bytes are flagged as placeholders.",
    summary: {
      clients: rows.length,
      missingMessagingDoc: rows.filter((r) => r.messagingDoc === "missing").map((r) => r.client),
      missingIcp: rows.filter((r) => text((r.brainDocs as Row).ICP) !== "written").map((r) => r.client),
      onboardingIncomplete: rows.filter((r) => /%/.test(text(r.onboarding)) && !/^100%/.test(text(r.onboarding))).map((r) => r.client),
      fullyReady: rows.filter((r) => !(r.missing as string[]).length).map((r) => r.client),
    },
    clients: rows,
  };
}

/* ── messaging_performance ─────────────────────────────────────────────────────────────────────── */

async function messagingPerformance(input: Row) {
  const all = await allClients();
  const picked = text(input.client) || strings(input.clients).length ? pickClients(all, strings(input.clients ?? input.client)) : all;
  const minSent = Math.max(10, num(input.minSent) || 50);
  const byId = new Map(picked.map((c) => [c.id, c]));
  const stats = await dbAll(`rr_campaign_stats?select=workspace_id,campaign_id,name,status,launched_at,connections_sent,connections_accepted,replies,first_touch,follow_up${picked.length === all.length ? "" : `&workspace_id=in.(${picked.map((c) => c.id).join(",")})`}&order=campaign_id.asc`);
  const ours = ourCampaigns(stats, (r: Row) => text(r.name)) as Row[];
  const ranked = ours
    .filter((r) => byId.has(text(r.workspace_id)) && num(r.connections_sent) >= minSent)
    .map((r) => ({
      client: byId.get(text(r.workspace_id))!.name, campaign: text(r.name), status: text(r.status), launched: text(r.launched_at).slice(0, 10),
      sent: num(r.connections_sent), accepted: num(r.connections_accepted), replies: num(r.replies),
      acceptanceRatePct: pct(num(r.connections_accepted), num(r.connections_sent)),
      replyRateOfAcceptedPct: pct(num(r.replies), num(r.connections_accepted)),
      connectionRequest: text(r.first_touch).slice(0, 400), firstMessage: text(r.follow_up).slice(0, 600),
    }))
    .sort((a, b) => num(b.replyRateOfAcceptedPct) - num(a.replyRateOfAcceptedPct));
  return {
    definitions: `Ranked by replies / accepted connections (all time, HeyReach's stored campaign totals, refreshed daily). Only campaigns with at least ${minSent} requests sent are ranked, so a lucky tiny campaign can't win. connectionRequest is the connection-request note; firstMessage is the first message after acceptance.`,
    campaignsRanked: ranked.length,
    byAcceptance: [...ranked].sort((a, b) => num(b.acceptanceRatePct) - num(a.acceptanceRatePct)).slice(0, 10).map((r) => ({ client: r.client, campaign: r.campaign, acceptanceRatePct: r.acceptanceRatePct, sent: r.sent })),
    campaigns: ranked,
  };
}

/* ── google_doc ────────────────────────────────────────────────────────────────────────────────── */

async function googleDoc(input: Row) {
  let url = text(input.url);
  if (!url && text(input.client)) {
    const [c] = pickClients(await allClients(), [text(input.client)]);
    url = text(c.guardrails.messaging_doc_url);
    if (!url) throw new Error(`${c.name} has no messaging doc link saved in QC Command (Configuration → the client → Messaging doc). Reach out to Kiril if it should have one.`);
  }
  if (!url) throw new Error("Give a Google Docs or Sheets link, or a client to open their messaging doc.");
  const sheet = /docs\.google\.com\/spreadsheets\/d\/([\w-]+)/.exec(url);
  if (sheet) {
    const gid = /[#&?]gid=(\d+)/.exec(url)?.[1] ?? "0";
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${sheet[1]}/export?format=csv&gid=${gid}`, { cache: "no-store", redirect: "follow" });
    if (!r.ok || /text\/html/i.test(r.headers.get("content-type") ?? "")) throw new Error("That sheet isn't readable. It needs to be shared as 'anyone with the link can view'.");
    const csv = await r.text();
    const lines = csv.split(/\r?\n/);
    return { kind: "sheet", rows: lines.length - 1, csv: lines.slice(0, 400).join("\n"), truncated: lines.length > 400 };
  }
  if (!googleDocsConfigured()) throw new Error("Google Docs isn't connected (GOOGLE_SERVICE_ACCOUNT_KEY is not set). Reach out to Kiril.");
  const tabs = await fetchMessagingTabs(url);
  const budget = 40_000; let used = 0;
  return {
    kind: "doc", tabs: tabs.map((t) => { const room = Math.max(0, budget - used); const md = t.markdown.slice(0, room); used += md.length; return { title: t.title, text: md, truncated: md.length < t.markdown.length }; }),
  };
}

/* ── outreach_people ───────────────────────────────────────────────────────────────────────────── */

async function outreachPeople(input: Row) {
  const all = await allClients();
  const picked = strings(input.clients ?? input.client).length ? pickClients(all, strings(input.clients ?? input.client)) : all;
  const nameOf = new Map(all.map((c) => [c.id, c.name]));
  const titles = strings(input.titleContains);
  const companies = strings(input.companyContains);
  const campaigns = strings(input.campaignContains);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(text(input.from)) ? text(input.from) : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(text(input.to)) ? text(input.to) : "";
  const ors = (field: string, terms: string[]) => (terms.length ? `&or=(${terms.map((t) => `${field}.ilike.*${encodeURIComponent(t.replace(/[(),*]/g, " "))}*`).join(",")})` : "");
  const filters = [
    picked.length === all.length ? "" : `&workspace_id=in.(${picked.map((c) => c.id).join(",")})`,
    from ? `&last_action_at=gte.${from}` : "",
    to ? `&last_action_at=lt.${endExclusive(to)}` : "",
    input.acceptedOnly === true ? "&connection_status=ilike.*accept*" : "",
  ].join("");
  // Title, company and campaign each OR across their terms; PostgREST allows one or= per request, so the
  // extra ones are applied here after fetching.
  const path = `rr_outreach?select=workspace_id,full_name,title,company,location,linkedin_url,campaign_name,sender_name,connection_status,message_status,last_action_at${filters}${ors("title", titles)}&order=last_action_at.desc.nullslast,heyreach_lead_id.asc`;
  let rowsOut: Row[];
  try { rowsOut = await dbAll(path, 40_000); }
  catch (error) {
    if (/PGRST205|404|does not exist/i.test(String(error))) throw new Error("The outreach log (rr_outreach) hasn't been created yet, so contacted-people questions can't be answered for every client. Use search_outreach (Cotool and Hetz only) and say so; reach out to Kiril to finish the setup.");
    throw error;
  }
  const has = (v: unknown, terms: string[]) => !terms.length || terms.some((t) => text(v).toLowerCase().includes(t.toLowerCase()));
  const filtered = rowsOut.filter((r) => has(r.company, companies) && has(r.campaign_name, campaigns));
  // One row per person (LinkedIn URL), keeping their most recent contact and every campaign they were in.
  const people = new Map<string, Row>();
  for (const r of filtered) {
    const key = text(r.linkedin_url).toLowerCase() || `${text(r.full_name)}|${text(r.company)}`.toLowerCase();
    const seen = people.get(key);
    if (!seen) people.set(key, { name: text(r.full_name), title: text(r.title), company: text(r.company), location: text(r.location), client: nameOf.get(text(r.workspace_id)) ?? "unknown client", lastContacted: text(r.last_action_at).slice(0, 10), campaigns: text(r.campaign_name), sender: text(r.sender_name), connection: text(r.connection_status), linkedin: text(r.linkedin_url) });
    else if (!text(seen.campaigns).includes(text(r.campaign_name))) seen.campaigns = `${text(seen.campaigns)}; ${text(r.campaign_name)}`;
  }
  const list = [...people.values()];
  const byClient: Row = {};
  for (const p of list) byClient[text(p.client)] = num(byClient[text(p.client)]) + 1;
  const covered = new Set(rowsOut.map((r) => text(r.workspace_id)));
  return {
    filters: { clients: picked.length === all.length ? "all" : picked.map((c) => c.name), titleContains: titles, companyContains: companies, campaignContains: campaigns, contactedFrom: from || null, contactedTo: to || null },
    uniquePeople: list.length, contacts: filtered.length, byClient,
    note: `Dates are when HeyReach last acted on the person (connection request or message). Clients with nothing in the log yet: ${picked.filter((c) => !covered.has(c.id)).map((c) => c.name).join(", ") || "none"}.`,
    people: list,
  };
}

/* ── Registry ──────────────────────────────────────────────────────────────────────────────────── */

const DATE_ARGS = {
  from: { type: "string", description: "First day of the range, YYYY-MM-DD (inclusive). Work it out from TODAY in the system prompt." },
  to: { type: "string", description: "Last day of the range, YYYY-MM-DD (inclusive). Defaults to today." },
};

export const INSIGHT_TOOLS: ToolDefinition[] = [
  {
    name: "client_scorecard",
    description: "THE tool for 'how is X doing', 'compare X and Y', 'which client is doing best/worst', 'whose reply rate dropped', 'how many replies did we get last week/this month'. One call returns, per client, for any date range: connection requests sent and accepted (acceptance %), people who replied, reply rate of accepted, positive replies, meetings booked — each with the previous period of the same length for comparison — plus live runway (active campaigns, leads pending, days of sending left) when 8 or fewer clients are asked for. Pass no clients for all clients. Prefer this over stitching heyreach_* and recent_replies calls together.",
    input_schema: { type: "object", properties: { clients: { type: "array", items: { type: "string" }, description: "Client names. Empty means all clients." }, ...DATE_ARGS } },
  },
  {
    name: "follow_up_list",
    description: "THE tool for 'who needs a follow-up', 'which leads haven't booked', 'who did we send a Calendly to that never booked', 'who went quiet'. Reads every conversation for a client (or all clients) and sorts the ones that need action into: they_replied_we_havent (ball is with us), sent_booking_link_no_meeting (we sent a booking link after their last reply and no meeting is recorded), went_quiet_after_our_reply (they engaged, we answered, silence for staleDays+). Each row says whether a meeting is booked. Negative leads are left out unless includeNegative. Returns counts by category plus every lead (long lists become one CSV).",
    input_schema: { type: "object", properties: { client: { type: "string", description: "Client name. Omit for all clients." }, category: { type: "array", items: { type: "string", enum: ["they_replied_we_havent", "sent_booking_link_no_meeting", "went_quiet_after_our_reply"] }, description: "Only these groups, when the question is about one (e.g. booking link sent but not booked)." }, staleDays: { type: "integer", description: "Days of silence before someone counts as gone quiet. Default 3." }, maxDaysSince: { type: "integer", description: "Leave out threads quieter than this many days. Default 90; they are still counted." }, includeNegative: { type: "boolean" } } },
  },
  {
    name: "client_readiness",
    description: "THE tool for onboarding gaps and 'what is missing': per client in one call, whether the messaging doc link is saved (it lives on the client in QC Command, NOT in the brain), which QC Brain docs are written / placeholder / missing (Brief, ICP, Personas, Voice, Engagement…), whether the client brief is saved, onboarding checklist progress, and setup (HeyReach, Slack channels, Granola, Airtable, morning brief). Also lists which clients miss a messaging doc or ICP. Use instead of calling brain_client per client.",
    input_schema: { type: "object", properties: { client: { type: "string", description: "One client. Omit for all clients." } } },
  },
  {
    name: "messaging_performance",
    description: "THE tool for 'which messaging works best', 'best hook', 'which connection request gets accepted most', across one client, several, or all clients. Ranks QC campaigns (with enough volume) by replies per accepted connection and by acceptance rate, each with the actual connection-request note and first message text. Use this before heyreach_campaign_sequence.",
    input_schema: { type: "object", properties: { client: { type: "string" }, clients: { type: "array", items: { type: "string" } }, minSent: { type: "integer", description: "Minimum requests sent to be ranked. Default 50." } } },
  },
  {
    name: "outreach_people",
    description: "THE tool for 'who have we contacted / reached out to' at the person level, for every client, with dates: 'every CISO we contacted', 'VPs of Sales we reached out to in September', 'everyone at Stripe we contacted for Cotool', 'who did campaign CT049 reach'. Filters: titleContains (pass every spelling and acronym at once, e.g. [\"VP of Sales\", \"VP Sales\", \"Vice President of Sales\", \"VP, Sales\"]), companyContains, campaignContains, clients, from/to (contact date, YYYY-MM-DD), acceptedOnly. Returns unique people (deduped by LinkedIn) with title, company, client, last contacted date, campaigns and sender, plus counts by client. Long lists become one CSV.",
    input_schema: { type: "object", properties: { clients: { type: "array", items: { type: "string" } }, titleContains: { type: "array", items: { type: "string" } }, companyContains: { type: "array", items: { type: "string" } }, campaignContains: { type: "array", items: { type: "string" } }, acceptedOnly: { type: "boolean" }, ...DATE_ARGS } },
  },
  {
    name: "google_doc",
    description: "Read a Google Doc (every tab, as text) or a Google Sheet (as CSV) from its link. Pass client instead of url to open that client's messaging doc. Docs and sheets need to be shared 'anyone with the link'. Use this whenever someone pastes a Google link or asks about a client's messaging doc.",
    input_schema: { type: "object", properties: { url: { type: "string" }, client: { type: "string" } } },
  },
];

export const INSIGHT_TOOL_NAMES = new Set(INSIGHT_TOOLS.map((t) => t.name));

export async function runInsightTool(name: string, input: Row): Promise<unknown> {
  switch (name) {
    case "client_scorecard": return clientScorecard(input);
    case "follow_up_list": return followUpList(input);
    case "client_readiness": return clientReadiness(input);
    case "messaging_performance": return messagingPerformance(input);
    case "google_doc": return googleDoc(input);
    case "outreach_people": return outreachPeople(input);
    default: throw new Error(`Unknown tool ${name}.`);
  }
}
