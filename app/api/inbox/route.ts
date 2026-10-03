// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { normalizePersonName } from "../../lib/person-name";
import { queryByIds } from "../../lib/chunk-query";
import { dedupeMessages } from "../../lib/message-dedupe";
import { assignmentsFor } from "../../lib/inbox-tags";
import { classifyConversationOrigin } from "../../../shared/conversation-origin.mjs";
import { slimImages } from "../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);

type Row = Record<string, unknown>;

async function query(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok)
    throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data as Row[]) : [];
}
/**
 * PostgREST hands back at most 1,000 rows per request no matter what `limit` says, and it does so
 * silently: a `limit=2000` custom range came back with the newest 1,000 and nothing to say the rest
 * existed, and a 20-conversation message batch with long threads lost its oldest messages the same
 * way. So anything that can exceed that ceiling is read in 1,000-row pages until either `cap` rows
 * are in hand or a short page says there is nothing more. The path must carry a total order (a
 * unique tiebreaker such as `id`), or offset paging can skip or repeat rows across page boundaries.
 */
const PAGE_SIZE = 1000;
async function queryPaged(url: string, key: string, path: string, cap = Number.POSITIVE_INFINITY) {
  const rows: Row[] = [];
  for (let offset = 0; rows.length < cap; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, cap - rows.length);
    const page = await query(url, key, `${path}&limit=${limit}&offset=${offset}`);
    rows.push(...page);
    if (page.length < limit) break;
  }
  return rows;
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    // Letters only: "Elizabeth (Lizzie) Siegle" was "E(".
    .map((part) => part.replace(/[^\p{L}\p{N}]/gu, "")[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
const nested = (value: unknown, key: string) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as Row)[key] &&
  typeof (value as Row)[key] === "object"
    ? ((value as Row)[key] as Row)
    : {};
const field = (value: unknown, key: string) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)[key]
    : undefined;
const senderNameFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = value && typeof value === "object" ? (value as Row) : {};
    const metadata =
      raw.reply_radar && typeof raw.reply_radar === "object"
        ? (raw.reply_radar as Row)
        : {};
    const sender =
      metadata.sender && typeof metadata.sender === "object"
        ? (metadata.sender as Row)
        : {};
    if (sender.name) return String(sender.name);
  }
  return "Unknown sender";
};
const campaignFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = value && typeof value === "object" ? (value as Row) : {};
    const metadata =
      raw.reply_radar && typeof raw.reply_radar === "object"
        ? (raw.reply_radar as Row)
        : {};
    const campaign =
      metadata.campaign && typeof metadata.campaign === "object"
        ? (metadata.campaign as Row)
        : {};
    if (campaign.name || campaign.id) return campaign;
  }
  return {};
};
const computeFollowUp = (thread: { direction: string; sentAt: unknown; body: string }[], sentiment: string | null) => {
  if (!thread.length) return { followUpUrgency: 0, followUpReason: null };
  const now = Date.now();
  const latest = thread[thread.length - 1];
  const latestAt = new Date(String(latest.sentAt)).getTime();
  const ageDays = (now - latestAt) / (1000 * 60 * 60 * 24);
  const inboundMessages = thread.filter((m) => m.direction === "inbound");
  const latestInbound = inboundMessages[inboundMessages.length - 1];
  const latestInboundAt = latestInbound ? new Date(String(latestInbound.sentAt)).getTime() : 0;
  const inboundAgeDays = latestInbound ? (now - latestInboundAt) / (1000 * 60 * 60 * 24) : Infinity;
  const latestInboundBody = latestInbound ? String(latestInbound.body || "").toLowerCase() : "";

  // Skip negative sentiment — lead doesn't want to hear from us
  if (sentiment === "negative") return { followUpUrgency: 0, followUpReason: null };

  let urgency = 0;
  let reason = "";

  // Pattern: Lead replied positively but we haven't followed up
  if (latest.direction === "inbound" && sentiment === "positive" && ageDays >= 1) {
    urgency = Math.min(100, 70 + ageDays * 3);
    reason = `Positive reply ${Math.floor(ageDays)}d ago — awaiting your follow-up.`;
  }
  // Pattern: Lead asked to be contacted later
  else if (latestInboundBody.match(/later|next (month|quarter|year)|few months|circle back|reach out.*(later|again)|not (right )?now|bad time|busy/)) {
    const delayDays = latestInboundBody.match(/next year/) ? 180 : latestInboundBody.match(/next quarter/) ? 60 : latestInboundBody.match(/next month|few months/) ? 30 : 14;
    if (inboundAgeDays >= delayDays) {
      urgency = Math.min(100, 60 + (inboundAgeDays - delayDays) * 2);
      reason = `Said "${latestInboundBody.length > 60 ? latestInboundBody.slice(0, 57) + "…" : latestInboundBody}" ${Math.floor(inboundAgeDays)}d ago — window to re-engage.`;
    }
  }
  // Pattern: No-show — they agreed to meet but went silent
  else if (latestInboundBody.match(/sure|sounds good|let'?s do it|book|schedule|set up|calendar/) && ageDays >= 3) {
    urgency = Math.min(100, 65 + ageDays * 2);
    reason = `Agreed to meet ${Math.floor(inboundAgeDays)}d ago but went silent — possible no-show.`;
  }
  // Pattern: Neutral reply sitting unanswered
  else if (latest.direction === "inbound" && sentiment === "neutral" && ageDays >= 2) {
    urgency = Math.min(100, 40 + ageDays * 2);
    reason = `Neutral reply ${Math.floor(ageDays)}d ago — opportunity to re-engage.`;
  }
  // Pattern: We sent outbound, no reply in 7+ days
  else if (latest.direction === "outbound" && ageDays >= 7 && inboundMessages.length > 0) {
    urgency = Math.min(100, 30 + ageDays);
    reason = `No reply in ${Math.floor(ageDays)}d after your last message — consider a nudge.`;
  }
  // Pattern: Stale conversation with prior engagement
  else if (inboundMessages.length > 0 && ageDays >= 14) {
    urgency = Math.min(100, 25 + ageDays * 0.5);
    reason = `Conversation went cold ${Math.floor(ageDays)}d ago after ${inboundMessages.length} replies — worth revisiting.`;
  }

  if (!reason) return { followUpUrgency: 0, followUpReason: null };
  return { followUpUrgency: Math.round(urgency), followUpReason: reason };
};

const age = (value: unknown) => {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(String(value)).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

/**
 * The message columns the inbox reads, and nothing else. `select=*` dragged every message's full
 * `raw_data` (the whole HeyReach webhook payload) across from Supabase only for this route to look at
 * its `reply_radar` key — sender, campaign, sentiment and the cached draft all live there, and so does
 * everything `dedupeMessages` and the origin classifier read. Selecting that one key keeps the
 * database leg of the hottest route proportional to what it uses.
 */
const MESSAGE_COLUMNS = "id,conversation_id,body,direction,sent_at,reply_radar:raw_data->reply_radar";
/**
 * The lead columns the inbox reads. Same reasoning as messages: a lead's `raw_data` also carries the whole
 * HeyReach payload, and every reader here (sender, campaign, ICP, enrichment, history status) only looks
 * under `reply_radar`. `withRawData` puts it back under `raw_data`.
 */
const LEAD_COLUMNS = "id,name,role,company,linkedin_profile_url,reply_radar:raw_data->reply_radar";
/** Puts the narrowed `reply_radar` column back where every reader expects it: under `raw_data`. */
const withRawData = (row: Row): Row =>
  row.raw_data && typeof row.raw_data === "object"
    ? row
    : { ...row, raw_data: row.reply_radar && typeof row.reply_radar === "object" ? { reply_radar: row.reply_radar } : {} };
/** How much of the latest message rides along on a list row. Nothing on the page shows more. */
const PREVIEW_CHARS = 280;
const truncate = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/**
 * One conversation's thread and the facts derived from it, shared by the list and the single-thread
 * read so both describe a conversation identically (same dedupe, same author names, same "latest
 * inbound" row the per-reply AI state is read from).
 */
function describeThread(messageRows: Row[], lead: Row) {
  const leadRaw = lead.raw_data && typeof lead.raw_data === "object" ? (lead.raw_data as Row) : {};
  const newestRawMessages = [...messageRows].reverse().map((message) => message.raw_data);
  const senderName = senderNameFrom(...newestRawMessages, leadRaw);
  const campaign = campaignFrom(...newestRawMessages, leadRaw);
  const thread = messageRows.map((message) => ({
    id: message.id,
    body: message.body,
    direction: message.direction,
    sentAt: message.sent_at,
    authorName:
      message.direction === "outbound"
        ? senderName
        : String(lead.name || "Unknown lead"),
  }));
  const latestInboundRow = [...messageRows].reverse().find((row) => row.direction === "inbound");
  const latestInboundRaw = latestInboundRow?.raw_data && typeof latestInboundRow.raw_data === "object" ? latestInboundRow.raw_data as Row : {};
  const sentimentData = nested(latestInboundRaw, "reply_radar");
  return { leadRaw, senderName, campaign, thread, sentimentData };
}

/**
 * One conversation's full thread, plus the cached draft for its latest reply — the detail the list
 * leaves out. Read with the same columns, dedupe and author naming as the list.
 */
async function readThread(url: string, key: string, conversationId: string) {
  const [conversation] = await query(
    url,
    key,
    `rr_conversations?select=*&id=eq.${encodeURIComponent(conversationId)}&limit=1`,
  );
  if (!conversation) return { ok: false, conversationId, thread: [], error: "Conversation not found." };
  const [leadRows, messages] = await Promise.all([
    conversation.lead_id
      ? query(url, key, `rr_leads?select=${LEAD_COLUMNS}&id=eq.${encodeURIComponent(String(conversation.lead_id))}&limit=1`).then((rows) => rows.map(withRawData))
      : Promise.resolve([] as Row[]),
    queryPaged(
      url,
      key,
      `rr_messages?select=${MESSAGE_COLUMNS}&conversation_id=eq.${encodeURIComponent(conversationId)}&order=sent_at.asc,id.asc`,
    ).then((rows) => rows.map(withRawData)),
  ]);
  const { thread, sentimentData } = describeThread(dedupeMessages(messages), leadRows[0] ?? {});
  return {
    ok: true,
    conversationId,
    thread,
    cachedDraft: String(sentimentData.cached_draft ?? "") || null,
    cachedReason: String(sentimentData.cached_reason ?? "") || null,
    analyzedAt: String(sentimentData.analyzed_at ?? "") || null,
    lastMessageAt: conversation.last_message_at ?? null,
    lastRefreshedAt: conversation.last_refreshed_at ?? null,
  };
}

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    return slimJson(
      { ok: false, conversations: [], error: "Supabase is not configured." },
      { status: 503 },
    );
  try {
    const params = new URL(request.url).searchParams;
    // `?conversationId=` reads one conversation's full thread. The list below deliberately carries no
    // message bodies (they were ~3.5MB of every inbox load), so the page asks for a thread here only
    // when a conversation is opened.
    const conversationId = (params.get("conversationId") ?? "").trim();
    if (conversationId) return slimJson(await readThread(url, key, conversationId));
    const requested =
      params
        .get("workspaces")
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean) ?? [];
    // Optional date window on the conversation's most recent activity. Parsed as whole days in the caller's
    // zone and already sent as ISO instants, so here they are passed straight through as PostgREST bounds on
    // last_message_at. A bad value is dropped rather than erroring, so a malformed range never empties the
    // inbox silently. When a range is set, it also lifts the newest-500 ceiling for that window: a custom
    // range is a deliberate look back, and capping it at 500 would quietly hide the older half of it.
    const isoOrNull = (value: string | null) => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) return null;
      const time = Date.parse(trimmed);
      return Number.isNaN(time) ? null : new Date(time).toISOString();
    };
    const since = isoOrNull(params.get("since"));
    const until = isoOrNull(params.get("until"));
    const rangeFilter = `${since ? `&last_message_at=gte.${encodeURIComponent(since)}` : ""}${until ? `&last_message_at=lte.${encodeURIComponent(until)}` : ""}`;
    const rowLimit = since || until ? 2000 : 500;
    // Per-step timings in a Server-Timing header, readable in the browser's network panel.
    const started = Date.now();
    const timings: string[] = [];
    let mark = started;
    const lap = (name: string) => { const now = Date.now(); timings.push(`${name};dur=${now - mark}`); mark = now; };
    const workspaces = await query(
      url,
      key,
      "rr_workspaces?select=id,name,slug,accent_color,logo_url&slug=neq.misc&order=name.asc",
    );
    const selected = requested.length
      ? workspaces.filter((workspace) =>
          requested.includes(String(workspace.slug)),
        )
      : workspaces;
    const workspaceIds = selected.map((workspace) => String(workspace.id));
    if (!workspaceIds.length)
      return slimJson({ ok: true, conversations: [] });
    // Newest conversations first with an explicit ceiling — the inbox is a working queue,
    // not an archive, and an unbounded fetch grows until PostgREST truncates it silently.
    const conversations = await queryByIds(workspaceIds, 20, (batch) =>
      queryPaged(
        url,
        key,
        `rr_conversations?select=*&workspace_id=in.(${batch.map(encodeURIComponent).join(",")})${rangeFilter}&order=last_message_at.desc,id.asc`,
        rowLimit,
      ),
    );
    lap("conversations");
    conversations.sort(
      (a, b) =>
        new Date(String(b.last_message_at)).getTime() -
        new Date(String(a.last_message_at)).getTime(),
    );
    const leadIds = [
      ...new Set(
        conversations.map((row) => String(row.lead_id)).filter(Boolean),
      ),
    ];
    const conversationIds = conversations.map((row) => String(row.id));
    const timed = <T,>(name: string, work: Promise<T>) => work.then((value) => { timings.push(`${name};dur=${Date.now() - mark}`); return value; });
    const [leads, messages, tagsByConversation] = await Promise.all([
      timed("leads", queryByIds(leadIds, 100, (batch) =>
        query(url, key, `rr_leads?select=${LEAD_COLUMNS}&id=in.(${batch.map(encodeURIComponent).join(",")})`).then((rows) => rows.map(withRawData)),
      )),
      timed("messages", queryByIds(conversationIds, 50, (batch) =>
        queryPaged(
          url,
          key,
          `rr_messages?select=${MESSAGE_COLUMNS}&conversation_id=in.(${batch.map(encodeURIComponent).join(",")})&order=sent_at.asc,id.asc`,
        ).then((rows) => rows.map(withRawData)),
      )),
      // The team's inbox tags on these conversations. Never fails the inbox: an account without the tags
      // table yet (migration not run) reads as no tags rather than a 500 on the whole queue.
      timed("tags", assignmentsFor(conversationIds).catch(() => new Map<string, string[]>())),
    ]);
    lap("leads_messages_tags");
    // Duplicate rows are collapsed on read so the thread is correct even before a refresh repairs the
    // records themselves. Shared with the purge, which must judge who spoke first from the same view.
    const deduped = dedupeMessages(messages);
    // Grouped once, not filtered per conversation: this used to be `deduped.filter(...)` inside both the filter
    // and the map below, which re-scanned every message for every conversation — O(conversations × messages) on
    // the hottest route. One pass into a map makes each lookup O(1).
    const messagesByConversation = new Map<string, Row[]>();
    for (const message of deduped) {
      const cid = String(message.conversation_id);
      const list = messagesByConversation.get(cid);
      if (list) list.push(message);
      else messagesByConversation.set(cid, [message]);
    }

    const workspaceById = new Map(selected.map((row) => [String(row.id), row]));
    const leadById = new Map(leads.map((row) => [String(row.id), row]));
    // Conversations the lead started are dropped outright. Reply Radar works outbound replies, so
    // someone who approached us is not a lead here at all and does not belong in the queue.
    // The classifier abstains unless it is certain, and only a certain verdict removes a row — the
    // whole point of that caution is that nothing reaches this filter on a guess.
    const excluded: string[] = [];
    const orphaned: string[] = [];
    // The classifier's read of each surviving conversation, kept so the non-campaign display filter below can
    // honour the same abstain-and-keep caution: a thread we could not read confidently ("unknown") is never
    // hidden on a guess.
    const originById = new Map<string, string>();
    const result = conversations.filter((conversation) => {
      // A conversation whose lead row is gone is not a lead any more. These used to render as an
      // "Unknown lead" card that could not be dismissed, which is how a deleted lead appeared to
      // survive deletion. Dropping them here also clears the wreckage left by earlier deletes that
      // failed silently, without waiting for a purge to run.
      if (!leadById.has(String(conversation.lead_id))) {
        orphaned.push(String(conversation.id));
        return false;
      }
      const verdict = classifyConversationOrigin({
        messages: messagesByConversation.get(String(conversation.id)) ?? [],
        leadRawData: leadById.get(String(conversation.lead_id))?.raw_data,
      });
      originById.set(String(conversation.id), verdict.origin);
      if (verdict.origin !== "inbound_lead") return true;
      excluded.push(String(conversation.id));
      return false;
    }).map((conversation) => {
      const lead = leadById.get(String(conversation.lead_id)) ?? {};
      const workspace =
        workspaceById.get(String(conversation.workspace_id)) ?? {};
      const messageRows = messagesByConversation.get(String(conversation.id)) ?? [];
      const { leadRaw, senderName, campaign, thread, sentimentData } = describeThread(messageRows, lead);
      const metadata = nested(leadRaw, "reply_radar");
      const enrichment = nested(metadata, "ai_ark");
      const latest = thread.at(-1);
      const latestReply = thread
        .filter((message) => message.direction === "inbound")
        .at(-1);
      // The page keys per-reply AI state on "the newest message that is not ours" — the same test it
      // used to run over the whole thread — so the list hands it that message's id and time.
      const latestNotOurs = [...thread].reverse().find((message) => message.direction !== "outbound");
      const sentiment = ["positive", "neutral", "negative"].includes(String(sentimentData.sentiment).toLowerCase()) ? String(sentimentData.sentiment).toLowerCase() : null;
      const analyzedAt = String(sentimentData.analyzed_at ?? "");
      const name = normalizePersonName(lead.name);
      // Prefer the cached AI follow-up score; fall back to the heuristic until it is scored.
      const heuristic = computeFollowUp(
        thread.map((m) => ({ direction: String(m.direction), sentAt: m.sentAt, body: String(m.body) })),
        sentiment,
      );
      const cachedFollowUpAt = String(sentimentData.followup_analyzed_at ?? "");
      const followUpUrgency = cachedFollowUpAt ? Number(sentimentData.followup_urgency) || 0 : heuristic.followUpUrgency;
      const followUpReason = cachedFollowUpAt ? String(sentimentData.followup_reason ?? "") || null : heuristic.followUpReason;
      const enrichmentCompany = nested(enrichment, "company");
      const companySummary = nested(enrichmentCompany, "summary");
      const positionGroups = Array.isArray(enrichment.positionGroups) ? enrichment.positionGroups : [];
      const currentGroup = positionGroups.find((value) => !field(nested(value, "date"), "end"));
      const currentGroupCompany = field(nested(currentGroup, "company"), "name");
      return {
        id: conversation.id,
        leadId: lead.id,
        // The team's inbox tags on this conversation, as tag ids. The client resolves them to names and
        // colours from the tag list it loads once; shipping the full definitions per row would repeat them.
        tags: tagsByConversation.get(String(conversation.id)) ?? [],
        initials: initials(name),
        name,
        role: String(lead.role || lead.title || enrichment.title || ""),
        company: String(lead.company || companySummary.name || enrichmentCompany.name || currentGroupCompany || ""),
        profileUrl: lead.linkedin_profile_url ?? lead.profile_url ?? null,
        photoUrl: enrichment.profilePhotoSource ?? enrichment.profilePhotoUrl ?? null,
        companyPhotoUrl: enrichment.companyPhotoSource ?? enrichment.companyPhotoUrl ?? null,
        enriched: Object.keys(enrichment).length > 0,
        headline: enrichment.headline ?? null,
        enrichedLocation: enrichment.location ?? null,
        industry: enrichment.industry ?? null,
        campaignName: campaign.name ?? null,
        // True when the conversation carries ANY campaign trace (a name or an id, from any source). This is the
        // "attributed to a campaign" signal the non-campaign display filter keys off — deliberately generous,
        // so a real reply with only a loosely-derived campaign is kept, never hidden.
        hasCampaign: Boolean(campaign.name || campaign.id),
        client: String(workspace.name || workspace.slug || "Unknown client"),
        clientSlug: workspace.slug,
        clientTone: String(workspace.accent_color || "#8b7cff"),
        // No `clientLogoUrl` here on purpose. Logos are stored as base64 data URIs, and there are only
        // three distinct ones, so shipping the workspace's logo on every conversation row put the same
        // few hundred kilobytes into the response several hundred times over — 10.3MB of a 12.8MB
        // payload, which is the whole reason the inbox sat blank for seconds after the page appeared.
        // The client resolves the logo from `workspaceDirectory` by slug, which it already loads once
        // from /api/admin/workspaces and caches in localStorage.
        senderName,
        leadScore: metadata.icp_score !== undefined && metadata.icp_score !== null ? Number(metadata.icp_score) || 0 : null,
        icpReason: String(metadata.icp_reason ?? "") || null,
        followUpScore: Number(conversation.score || 0),
        score: Number(conversation.score || 0),
        tier: ["hot", "warm", "nurture"].includes(String(conversation.tier))
          ? conversation.tier
          : "nurture",
        reason: String(
          conversation.score_reason || "New reply received from HeyReach.",
        ),
        preview: truncate(String(latest?.body || ""), PREVIEW_CHARS),
        age: age(conversation.last_message_at),
        lastMessageAt: conversation.last_message_at,
        latestReplyAt: latestReply?.sentAt ?? conversation.last_message_at,
        replies: thread.filter((message) => message.direction === "inbound")
          .length,
        avatar: "#3c365e",
        sentiment,
        // The cached draft and its reason are not on the list: only the open conversation uses them, and
        // they are some of the longest text a row has. They come with the thread (`?conversationId=`).
        // `analyzedAt` stays, because whether a reply has been analysed is a list-level fact.
        analyzedAt: analyzedAt || null,
        followUpUrgency,
        followUpReason,
        followUpAnalyzedAt: cachedFollowUpAt || null,
        lastRefreshedAt: conversation.last_refreshed_at ?? null,
        // What the list needs from the thread, without the thread itself: who spoke last (the ✓ and the
        // "needs reply" count), which reply the AI state belongs to, and how long the thread is.
        lastDirection: latest ? String(latest.direction) : null,
        latestInboundId: latestNotOurs ? String(latestNotOurs.id) : null,
        latestInboundAt: latestNotOurs?.sentAt ?? null,
        messageCount: thread.length,
      };
    });
    // Some clients wire their HeyReach to track every conversation they have, including their own inbound and
    // their own non-QC outreach. Those come through with no campaign attribution and clutter the queue. Hide
    // any conversation we could not tie to a campaign — but ONLY when the classifier read the thread
    // confidently; an "unknown" verdict (history we could not read) is kept, the same abstain-and-keep caution
    // the origin filter uses, so a genuine QC reply whose attribution was momentarily lost is never hidden on a
    // guess. This is a DISPLAY filter only: the rows stay in the database untouched, so nothing is lost and the
    // rule is fully reversible.
    const hiddenNonCampaign: string[] = [];
    const visible = result.filter((row) => {
      if (row.hasCampaign || originById.get(String(row.id)) === "unknown") return true;
      hiddenNonCampaign.push(String(row.id));
      return false;
    });
    // Server log only. Nothing about this reaches the inbox, but a dropped row that turned out to be
    // a real outbound lead would otherwise leave no trace anywhere to find it by.
    if (excluded.length) console.info("reply_radar_inbox_dropped_lead_initiated", { count: excluded.length, conversationIds: excluded.slice(0, 25) });
    if (orphaned.length) console.info("reply_radar_inbox_dropped_orphaned", { count: orphaned.length, conversationIds: orphaned.slice(0, 25) });
    if (hiddenNonCampaign.length) console.info("reply_radar_inbox_hidden_non_campaign", { count: hiddenNonCampaign.length, conversationIds: hiddenNonCampaign.slice(0, 25) });
    lap("build");
    timings.push(`total;dur=${Date.now() - started}`);
    return slimJson(
      { ok: true, conversations: visible, hiddenNonCampaign: hiddenNonCampaign.length },
      { headers: { "Server-Timing": timings.join(", ") } },
    );
  } catch (error) {
    return slimJson(
      {
        ok: false,
        conversations: [],
        error: error instanceof Error ? error.message : "Inbox unavailable",
      },
      { status: 502 },
    );
  }
}
