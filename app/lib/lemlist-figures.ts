// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * lemlist campaign figures in the shapes HeyReach's already have, so everything that reports on campaigns
 * (morning brief, end of week, personal brief, QC Bot, analytics) reads a lemlist client exactly as it reads
 * a HeyReach one. To the team the two are the same thing: an outreach account with campaigns and senders.
 *
 * ── How lemlist's numbers map onto HeyReach's ───────────────────────────────────────────────────
 *   connections sent      the LinkedIn invites sent: the sum of `invited` over the campaign's steps
 *   connections accepted  invitationAccepted
 *   replies               replied (every channel, as HeyReach counts message + InMail replies)
 *   messages started      messagesSent
 *   list size / pending   nbLeads / nbLeads − nbLeadsLaunched (leads not yet started)
 *   status                running → IN_PROGRESS, paused → PAUSED, ended/archived → FINISHED, draft → DRAFT
 * Only our campaigns (a QC code in the name) count, the same rule as HeyReach (shared/campaign-code.mjs).
 *
 * ── Stored copy ─────────────────────────────────────────────────────────────────────────────────
 * `refreshLemlistStats` writes the same rows into rr_campaign_stats and rr_daily_stats, with ids prefixed
 * `lemlist:` (campaigns and senders) so HeyReach's own sync never prunes or overwrites them.
 */

import { isOurCampaign } from "../../shared/campaign-code.mjs";
import type { BriefDay, CampaignFacts, LiveFigures } from "./morning-brief";
import { batchCampaignStats, listCampaigns, teamSenders, teamUsers } from "./lemlist";

type Row = Record<string, unknown>;
type Config = { url: string; key: string };
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const int = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);

export const LEMLIST_PREFIX = "lemlist:";
const STATUS: Record<string, string> = { running: "IN_PROGRESS", paused: "PAUSED", ended: "FINISHED", archived: "FINISHED", draft: "DRAFT", errors: "PAUSED" };
export const heyReachStatus = (status: string) => STATUS[status.toLowerCase()] ?? (status.toUpperCase() || "UNKNOWN");

export type LemlistCampaignFigures = {
  id: string; name: string; status: string; launchedAt: string;
  total: number; pending: number; launched: number;
  sent: number; accepted: number; replies: number; messages: number;
  emailSent: number; emailReplies: number; emailOpened: number; emailBounced: number; emailUnsubscribed: number;
  interested: number; reached: number;
  /** Whether the campaign does LinkedIn work at all (invites or LinkedIn messages); an email-only one does not. */
  linkedin: boolean;
  senderIds: string[]; senderNames: string[];
};

/**
 * The counts out of one batch-stats row, split by channel. The LinkedIn four (invites sent, accepted,
 * replies, messages) are what HeyReach's figures mean; email is kept apart (sent, replies, opened, bounced),
 * because an email-only campaign has no connection requests and its replies are not LinkedIn replies.
 * When lemlist gives no per-channel split, everything is read as LinkedIn, as before.
 */
function counts(row: Row) {
  const steps = Array.isArray(row.steps) ? row.steps.map(object) : [];
  const perChannel = object(row.perChannel);
  const split = Object.keys(perChannel).length > 0;
  const linkedin = object(perChannel.linkedin);
  const email = object(perChannel.email);
  return {
    sent: steps.reduce((sum, step) => sum + int(step.invited), 0),
    accepted: int(row.invitationAccepted ?? linkedin.invitationAccepted),
    replies: split ? int(linkedin.replied) : int(row.replied ?? row.nbLeadsAnswered),
    messages: split ? int(linkedin.sent) : int(row.messagesSent),
    emailSent: int(email.sent),
    emailReplies: int(email.replied),
    emailOpened: int(email.opened),
    emailBounced: int(email.bounced),
    emailUnsubscribed: int(email.unsubscribed),
  };
}

/** Our lemlist campaigns with their lifetime figures and senders. Throws if lemlist cannot be read. */
export async function lemlistCampaignFigures(apiKey: string): Promise<{ campaigns: LemlistCampaignFigures[]; senderNames: Map<string, string> }> {
  const [all, users, senders] = await Promise.all([listCampaigns(apiKey), teamUsers(apiKey).catch(() => new Map<string, string>()), teamSenders(apiKey).catch(() => [])]);
  const ours = all.filter((row) => isOurCampaign(row.name));
  const sendersOf = new Map<string, string[]>();
  for (const sender of senders) for (const id of sender.campaignIds) sendersOf.set(id, [...(sendersOf.get(id) ?? []), sender.userId]);
  const stats = new Map<string, Row>();
  for (let i = 0; i < ours.length; i += 100) {
    for (const row of await batchCampaignStats(apiKey, ours.slice(i, i + 100).map((c) => c.id), "2020-01-01T00:00:00.000Z", new Date().toISOString())) stats.set(text(row.campaignId), row);
  }
  const campaigns = ours.map((campaign) => {
    const row = stats.get(campaign.id) ?? {};
    const total = int(row.nbLeads);
    const launched = int(row.nbLeadsLaunched);
    const ids = sendersOf.get(campaign.id) ?? [];
    return {
      id: campaign.id,
      name: campaign.name,
      status: heyReachStatus(campaign.status),
      launchedAt: campaign.createdAt,
      total,
      launched,
      pending: Math.max(0, total - launched),
      ...counts(row),
      interested: int(row.nbLeadsInterested),
      reached: int(row.nbLeadsReached),
      linkedin: (() => { const c = counts(row); return c.sent > 0 || c.messages > 0 || c.accepted > 0 || c.emailSent === 0; })(),
      senderIds: ids,
      senderNames: ids.map((id) => users.get(id) ?? "").filter(Boolean),
    };
  });
  return { campaigns, senderNames: users };
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** Day by day sending for the given campaigns over the last `days` UTC days (newest first), optionally one sender. */
export async function lemlistDailyFigures(apiKey: string, campaignIds: string[], days: number, sendUser = ""): Promise<Array<BriefDay & { messages: number; emailSent: number; emailReplies: number }>> {
  if (!campaignIds.length) return [];
  const today = new Date();
  const dates = Array.from({ length: days }, (_, index) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - index)));
  const out: Array<BriefDay & { messages: number; emailSent: number; emailReplies: number }> = [];
  // Four days at a time: lemlist allows about 20 calls per two seconds per key.
  for (let i = 0; i < dates.length; i += 4) {
    const chunk = await Promise.all(dates.slice(i, i + 4).map(async (date) => {
      const start = `${dayKey(date)}T00:00:00.000Z`;
      const end = `${dayKey(date)}T23:59:59.999Z`;
      let rows: Row[] = [];
      for (let j = 0; j < campaignIds.length; j += 100) rows = rows.concat(await batchCampaignStats(apiKey, campaignIds.slice(j, j + 100), start, end, sendUser));
      const sum = rows.map(counts).reduce((acc, row) => ({ sent: acc.sent + row.sent, accepted: acc.accepted + row.accepted, replies: acc.replies + row.replies, messages: acc.messages + row.messages, emailSent: acc.emailSent + row.emailSent, emailReplies: acc.emailReplies + row.emailReplies }), { sent: 0, accepted: 0, replies: 0, messages: 0, emailSent: 0, emailReplies: 0 });
      return { day: dayKey(date), ...sum };
    }));
    out.push(...chunk);
  }
  return out;
}

/**
 * The brief's live figures from lemlist, in the same shape `gatherLiveFigures` gives for HeyReach. Never
 * throws: `available: false` with a reason sends the brief to the stored copy, which says so.
 */
export async function lemlistLiveFigures(apiKey: string, historyDays = 21): Promise<LiveFigures> {
  const key = apiKey.trim();
  if (!key) return { available: false, reason: "", campaigns: [], days: [] };
  try {
    // The brief's campaign figures are LinkedIn ones; lemlist email campaigns reach it as email
    // (rr_email_campaign_stats, read by shared/brief-channels.mjs).
    const campaigns = (await lemlistCampaignFigures(key)).campaigns.filter((c) => c.linkedin);
    const days = await lemlistDailyFigures(key, campaigns.map((c) => c.id), historyDays);
    const facts: CampaignFacts[] = campaigns.map((c) => ({
      name: c.name,
      status: c.status,
      // Active the way HeyReach's is judged: running with leads still to start (heyreach-campaigns.ts).
      isActive: c.status === "IN_PROGRESS" && c.pending > 0,
      sent: c.sent,
      accepted: c.accepted,
      replies: c.replies,
      pending: c.pending,
      total: c.total,
      launchedAt: c.launchedAt,
      senders: c.senderNames,
      senderIds: c.senderIds.map((id) => `${LEMLIST_PREFIX}${id}`),
    }));
    return { available: true, reason: "", campaigns: facts, days: days.map(({ day, sent, accepted, replies }) => ({ day, sent, accepted, replies })) };
  } catch (error) {
    return { available: false, reason: `lemlist could not be read: ${error instanceof Error ? error.message : "unknown error"}`, campaigns: [], days: [] };
  }
}

/** HeyReach's and lemlist's live figures as one: campaigns side by side, the day series added day by day. */
export function mergeLiveFigures(a: LiveFigures, b: LiveFigures): LiveFigures {
  if (!a.available) return b.available ? b : a;
  if (!b.available) return a;
  const byDay = new Map<string, BriefDay>();
  for (const row of [...a.days, ...b.days]) {
    const prior = byDay.get(row.day) ?? { day: row.day, sent: 0, accepted: 0, replies: 0 };
    byDay.set(row.day, { day: row.day, sent: prior.sent + row.sent, accepted: prior.accepted + row.accepted, replies: prior.replies + row.replies });
  }
  return { available: true, reason: "", campaigns: [...a.campaigns, ...b.campaigns], days: [...byDay.values()].sort((x, y) => y.day.localeCompare(x.day)) };
}

async function rest(config: Config, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  }).catch(() => null);
  if (!response) return { ok: false, status: 0, data: null };
  const body = await response.text().catch(() => "");
  let data: unknown = body;
  try { data = body ? JSON.parse(body) : null; } catch { /* keep text */ }
  return { ok: response.ok, status: response.status, data };
}

/**
 * The stored copy of a client's lemlist figures, refreshed by the worker each hour: one rr_campaign_stats row
 * per campaign of ours (`lemlist:<campaign id>`), and rr_daily_stats for the last 14 days, per sender
 * (`lemlist:<user id>`) and, for a client with no HeyReach key, the client-wide total row (sender '').
 * A client with both keys keeps HeyReach's total row; lemlist's per-sender rows still land beside it.
 */
export async function refreshLemlistStats(config: Config, workspace: { id: string; lemlist_api_key?: string | null }, hasHeyReach: boolean): Promise<{ campaigns: number; days: number; error?: string }> {
  const apiKey = text(workspace.lemlist_api_key);
  if (!apiKey) return { campaigns: 0, days: 0 };
  const ws = `workspace_id=eq.${encodeURIComponent(workspace.id)}`;
  const now = new Date().toISOString();
  const figures = await lemlistCampaignFigures(apiKey);
  const { senderNames } = figures;
  const campaigns = figures.campaigns.filter((c) => c.linkedin);
  const emailCampaigns = figures.campaigns.filter((c) => c.emailSent > 0);
  if (emailCampaigns.length) {
    // lemlist's email campaigns sit beside Email Bison's, ids prefixed `lemlist:` so neither overwrites the other.
    await rest(config, "rr_email_campaign_stats?on_conflict=workspace_id,campaign_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(emailCampaigns.map((c) => ({
        workspace_id: workspace.id,
        campaign_id: `${LEMLIST_PREFIX}${c.id}`,
        name: c.name,
        status: c.status,
        total_leads: c.total,
        leads_contacted: c.reached || c.launched,
        emails_sent: c.emailSent,
        unique_replies: c.emailReplies,
        interested: c.interested,
        bounced: c.emailBounced,
        unsubscribed: c.emailUnsubscribed,
        unique_opens: c.emailOpened,
        created_at: c.launchedAt || null,
        refreshed_at: now,
      }))),
    });
  }
  const keepEmail = emailCampaigns.map((c) => `"${LEMLIST_PREFIX}${c.id}"`).join(",");
  await rest(config, `rr_email_campaign_stats?${ws}&campaign_id=like.${encodeURIComponent(`${LEMLIST_PREFIX}*`)}${keepEmail ? `&campaign_id=not.in.(${encodeURIComponent(keepEmail)})` : ""}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  // A lemlist client without Email Bison gets its email days from lemlist (the table is Bison's otherwise).
  if (emailCampaigns.length) {
    const linked = await rest(config, `rr_workspaces?select=emailbison_workspace_id&id=eq.${encodeURIComponent(workspace.id)}&limit=1`);
    const hasBison = Array.isArray(linked.data) && Boolean(object(linked.data[0]).emailbison_workspace_id);
    if (!hasBison) {
      const emailDays = await lemlistDailyFigures(apiKey, emailCampaigns.map((c) => c.id), 14);
      await rest(config, "rr_email_daily_stats?on_conflict=workspace_id,day", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(emailDays.map((day) => ({ workspace_id: workspace.id, day: day.day, sent: day.emailSent, replies: day.emailReplies, interested: 0, bounced: 0, opens: 0, refreshed_at: now }))),
      });
    }
  }
  if (campaigns.length) {
    const written = await rest(config, "rr_campaign_stats?on_conflict=workspace_id,campaign_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(campaigns.map((c) => ({
        workspace_id: workspace.id,
        campaign_id: `${LEMLIST_PREFIX}${c.id}`,
        name: c.name,
        status: c.status,
        launched_at: c.launchedAt || null,
        sender_ids: c.senderIds.map((id) => `${LEMLIST_PREFIX}${id}`),
        total_leads: c.total,
        leads_pending: c.pending,
        leads_in_progress: c.launched,
        leads_finished: 0,
        connections_sent: c.sent,
        connections_accepted: c.accepted,
        replies: c.replies,
        messages_started: c.messages,
        refreshed_at: now,
      }))),
    });
    if (!written.ok) return { campaigns: 0, days: 0, error: `rr_campaign_stats ${written.status}: ${JSON.stringify(written.data).slice(0, 160)}` };
  }
  // lemlist campaigns that are gone or no longer ours leave the copy; HeyReach's rows are never touched.
  const keep = campaigns.map((c) => `"${LEMLIST_PREFIX}${c.id}"`).join(",");
  await rest(config, `rr_campaign_stats?${ws}&campaign_id=like.${encodeURIComponent(`${LEMLIST_PREFIX}*`)}${keep ? `&campaign_id=not.in.(${encodeURIComponent(keep)})` : ""}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });

  const ids = campaigns.map((c) => c.id);
  const senderIds = [...new Set(campaigns.flatMap((c) => c.senderIds))];
  const DAYS = 14;
  const rows: Row[] = [];
  if (!hasHeyReach) {
    for (const day of await lemlistDailyFigures(apiKey, ids, DAYS)) rows.push({ workspace_id: workspace.id, day: day.day, sender_id: "", sender_name: "", connections_sent: day.sent, connections_accepted: day.accepted, messages_sent: day.messages, replies: day.replies, refreshed_at: now });
  }
  for (const userId of senderIds) {
    const own = campaigns.filter((c) => c.senderIds.includes(userId)).map((c) => c.id);
    for (const day of await lemlistDailyFigures(apiKey, own, DAYS, userId)) rows.push({ workspace_id: workspace.id, day: day.day, sender_id: `${LEMLIST_PREFIX}${userId}`, sender_name: senderNames.get(userId) ?? "", connections_sent: day.sent, connections_accepted: day.accepted, messages_sent: day.messages, replies: day.replies, refreshed_at: now });
  }
  if (rows.length) {
    const written = await rest(config, "rr_daily_stats?on_conflict=workspace_id,day,sender_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!written.ok) return { campaigns: campaigns.length, days: 0, error: `rr_daily_stats ${written.status}: ${JSON.stringify(written.data).slice(0, 160)}` };
  }
  return { campaigns: campaigns.length, days: rows.length };
}
