// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { queryByIds } from "../../lib/chunk-query";
import { ourCampaigns } from "../../../shared/campaign-code.mjs";
import { slimImages } from "../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


type Row = Record<string, unknown>;
type CampaignMetric = {
  workspaceId: string; client: string; campaignId: string; name: string;
  connectionsSent: number; connectionsAccepted: number; replies: number;
  /** Replies we stored in the last seven days. The lifetime `replies` figure cannot answer "this week". */
  replies7d: number;
  messagesStarted: number; acceptanceRate: number; replyRate: number;
  positiveReplies: number; positiveReplyRate: number;
  launchedAt: string | null; status: string | null;
};
const campaignCache = new Map<string, { expires: number; rows: Row[] }>();
const campaignListCache = new Map<string, { expires: number; rows: Row[] }>();
function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

async function supabaseResponse(path: string, extraHeaders: Record<string, string> = {}) {
  const { url, key } = config();
  if (!url || !key) return null;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...extraHeaders },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return response;
}

async function supabase(path: string) {
  const response = await supabaseResponse(path);
  return response ? (await response.json()) as Row[] : null;
}

/**
 * The same read, but every row of it.
 *
 * PostgREST caps a single response at 1000 rows, and a plain `supabase()` call silently takes the first
 * 1000 and drops the rest. On a table larger than that — which both the conversations and the messages
 * reads are — the dropped rows are the ones the ordering pushes to the end: newest conversations (no
 * order → physical/oldest-first, so the recent ones vanish) and newest messages (`sent_at.asc`, so the
 * latest replies vanish). That is exactly what made the recent days of the reply-momentum chart crater:
 * recent replies living in newly-created threads were never loaded. So page through with limit/offset
 * until a short page comes back, and hand back the whole set. The caller must pass an explicit `order`
 * so the offset windows are stable across pages.
 *
 * The pages used to be fetched one after another. The first page now asks PostgREST for the exact
 * total (`Content-Range`), so every later offset is known up front and they all go at once. The result
 * is assembled exactly as the sequential walk would have: in offset order, stopping at the first short
 * or empty page, and carrying on one page at a time if the last page came back full (rows inserted
 * since the count). With no usable count it simply is the sequential walk.
 */
async function supabaseAll(path: string, pageSize = 1000): Promise<Row[]> {
  const all: Row[] = [];
  const separator = path.includes("?") ? "&" : "?";
  const pagePath = (offset: number) => `${path}${separator}limit=${pageSize}&offset=${offset}`;
  const firstResponse = await supabaseResponse(pagePath(0), { Prefer: "count=exact" });
  if (!firstResponse) return all;
  const total = Number(String(firstResponse.headers.get("content-range") ?? "").split("/")[1]);
  const first = (await firstResponse.json()) as Row[];
  if (!first || first.length === 0) return all;
  all.push(...first);
  if (first.length < pageSize) return all;
  let offset = pageSize;
  if (Number.isFinite(total) && total > pageSize) {
    const offsets: number[] = [];
    for (let next = pageSize; next < total; next += pageSize) offsets.push(next);
    const pages = await Promise.all(offsets.map((next) => supabase(pagePath(next))));
    for (const page of pages) {
      if (!page || page.length === 0) return all;
      all.push(...page);
      if (page.length < pageSize) return all;
      offset += pageSize;
    }
  }
  for (; ; offset += pageSize) {
    const page = await supabase(pagePath(offset));
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

/** The team works New York hours, so "a day" on this page is a New York calendar day. */
const TEAM_ZONE = "America/New_York";
const dayKeyFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TEAM_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
/** YYYY-MM-DD of an instant, on the New York calendar. */
const easternDayKey = (date: Date) => dayKeyFormat.format(date);
/** A YYYY-MM-DD key moved by whole days. Noon UTC keeps the arithmetic clear of any DST edge. */
const shiftDayKey = (key: string, days: number) => new Date(Date.parse(`${key}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function writeSupabase(path: string, body: unknown) {
  const { url, key } = config();
  if (!url || !key) return;
  await fetch(`${url}/rest/v1/${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch(() => null);
}

async function heyReachCampaignStats(workspace: Row) {
  const workspaceId = String(workspace.id);
  const cached = campaignCache.get(workspaceId);
  if (cached && cached.expires > Date.now()) return cached.rows;
  const apiKey = String(workspace.heyreach_api_key_ciphertext ?? "").trim();
  if (!apiKey) return [];
  const response = await fetch("https://api.heyreach.io/api/public/stats/GetOverallStatsByCampaign", {
    method: "POST",
    headers: { "X-API-KEY": apiKey, "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accountIds: [], campaignIds: [], startDate: "2020-01-01T00:00:00.000Z", endDate: new Date().toISOString() }),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HeyReach campaign stats returned ${response.status} for ${workspace.name}.`);
  // A client's own pre-engagement campaigns share this API key. They are dropped here, at the edge,
  // so that nothing downstream — engagement duration most of all — can quietly count them as our work.
  const rows = ourCampaigns(Array.isArray(payload?.overallStats) ? payload.overallStats as Row[] : [], (row) => row.campaignName);
  campaignCache.set(workspaceId, { expires: Date.now() + 5 * 60_000, rows });
  // No `metadata` key: `rr_sync_runs` has never had that column, so this insert has been
  // 400ing for its whole life and `writeSupabase`'s .catch swallowed it — the campaign-metrics
  // row never reached the audit feed. The counts below are the part anyone reads, and stashing
  // the full HeyReach payload per poll is what made this table 97% of the database.
  void writeSupabase("rr_sync_runs", {
    workspace_id: workspaceId, source: "heyreach", run_type: "campaign_metrics", status: "success",
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    records_seen: rows.length, records_written: rows.length,
  });
  return rows;
}

/**
 * Campaign launch dates only exist on the campaign records themselves, not on the stats
 * rollup, so the two have to be joined. Names follow an "XX001:" convention but the number
 * is not a reliable launch order, so the real `startedAt` is always used.
 *
 * The convention does decide *whose* campaign it is — see `shared/campaign-code.mjs`. This list is
 * where the engagement-duration bug lived: a client's own 2024 experiment supplied the earliest
 * `startedAt` and so became the date we claimed to have started working with them.
 */
async function heyReachCampaignList(workspace: Row) {
  const workspaceId = String(workspace.id);
  const cached = campaignListCache.get(workspaceId);
  if (cached && cached.expires > Date.now()) return cached.rows;
  const apiKey = String(workspace.heyreach_api_key_ciphertext ?? "").trim();
  if (!apiKey) return [];
  const pageSize = 100;
  const page = async (offset: number) => {
    const response = await fetch("https://api.heyreach.io/api/public/campaign/GetAll", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ offset, limit: pageSize }),
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    }).catch(() => null);
    if (!response?.ok) return null;
    return await response.json().catch(() => null) as { items?: Row[]; totalCount?: number } | null;
  };
  /**
   * HeyReach caps a page at 100 records. This used to walk the pages in a `for` loop, one awaited
   * request after another, up to twenty of them per client — and with a client on every row of the
   * sidebar that serialised into the bulk of the wait before the analytics page could paint.
   *
   * The first page reports `totalCount`, so after it there is nothing left to discover: the
   * remaining offsets are arithmetic and can all go at once. One round-trip plus one parallel batch
   * instead of up to twenty in single file.
   */
  const first = await page(0);
  if (!first) return [];
  const items = Array.isArray(first.items) ? first.items : [];
  const total = Number(first.totalCount ?? 0);
  const rows: Row[] = [...ourCampaigns(items, (row) => row.name)];
  if (items.length >= pageSize && total > pageSize) {
    const offsets: number[] = [];
    // The 2,000 ceiling is kept from the loop it replaces — a guard against a bad `totalCount`
    // turning into an unbounded fan-out.
    for (let offset = pageSize; offset < Math.min(total, 2_000); offset += pageSize) offsets.push(offset);
    const pages = await Promise.all(offsets.map((offset) => page(offset)));
    for (const result of pages) {
      // Paging is judged on what HeyReach returned, not on what survived the filter: comparing a
      // filtered length against `totalCount` would lose later pages.
      if (result?.items?.length) rows.push(...ourCampaigns(result.items, (row) => row.name));
    }
  }
  campaignListCache.set(workspaceId, { expires: Date.now() + 10 * 60_000, rows });
  return rows;
}

// Aggregating HeyReach stats plus our own message rows across a client can exceed the 15s default on a
// busy account; Pro allows the headroom.
export const maxDuration = 120;

/**
 * Everything the page needs from our own tables, already reduced.
 *
 * Two sources produce this one shape: the `rr_analytics_overview` database function, which aggregates
 * inside Postgres and returns a few hundred rows, and the row-by-row fallback below, which reads every
 * conversation and message and reduces them here (what this route always did). `assemble` turns either
 * into the response, so the two cannot drift apart in how a figure is computed.
 *
 * `messages` is grouped by every attribute any figure reads. `firstSeq` is the position of the group's
 * first message in the order the row-by-row read returns them — that order decides which campaign or
 * sender wins a tie in the top-12 rankings and the order of each one's client list, so it is carried
 * through rather than lost to the grouping.
 */
type Aggregates = {
  conversations: { workspaceId: string; tier: unknown; count: number }[];
  messages: { workspaceId: string; direction: unknown; campaign: unknown; sender: unknown; sentiment: unknown; recent: boolean; count: number; firstSeq: number }[];
  /** Inbound replies per New York calendar day. Covers at least the fourteen days the chart draws. */
  inboundByDay: Record<string, number>;
  responseSumMs: number;
  responseCount: number;
};

/**
 * The row-by-row path, kept for a database without the `rr_analytics_overview` function.
 *
 * Same reads as ever, minus what was never used: no message bodies, and no `raw_data` — the three values
 * read out of that JSON are lifted out by PostgREST (`->`, so they arrive as the same JSON values the old
 * code read off the parsed object), which is most of the bytes this route used to move. Order and
 * batching are unchanged so `firstSeq` reproduces the old iteration order exactly.
 */
async function aggregateRows(ids: string[], weekAgo: number): Promise<Aggregates> {
  const filter = (batch: string[]) => batch.map(encodeURIComponent).join(",");
  // Every conversation, paged in full — never the first 1000. An explicit order keeps the offset windows
  // stable across pages; without it the pages could overlap or skip, and a truncated list here is what
  // dropped the newest threads (and their recent replies) from the whole page.
  const conversations = await queryByIds(ids, 20, async (batch) =>
    (await supabaseAll(`rr_conversations?select=id,workspace_id,tier&workspace_id=in.(${filter(batch)})&order=id.asc`)) ?? [],
  );
  const conversationIdList = conversations.map((row) => String(row.id)).filter(Boolean);
  // Every message of those conversations, paged in full — a large batch used to lose its newest messages
  // to the 1000-row cap under `sent_at.asc`.
  const messages = await queryByIds(conversationIdList, 20, async (batch) =>
    (await supabaseAll(
      `rr_messages?select=conversation_id,direction,sent_at,campaign:raw_data->reply_radar->campaign->name,sender:raw_data->reply_radar->sender->name,sentiment:raw_data->reply_radar->sentiment` +
        `&conversation_id=in.(${filter(batch)})&order=sent_at.asc,id.asc`,
    )) ?? [],
  );
  const conversationWorkspace = new Map(conversations.map((row) => [String(row.id), String(row.workspace_id)]));

  const conversationGroups = new Map<string, Aggregates["conversations"][number]>();
  for (const row of conversations) {
    const workspaceId = String(row.workspace_id);
    const key = JSON.stringify([workspaceId, row.tier ?? null]);
    const group = conversationGroups.get(key) ?? { workspaceId, tier: row.tier ?? null, count: 0 };
    group.count += 1;
    conversationGroups.set(key, group);
  }

  const messageGroups = new Map<string, Aggregates["messages"][number]>();
  const inboundByDay: Record<string, number> = {};
  const byConversation = new Map<string, Row[]>();
  messages.forEach((message, index) => {
    const workspaceId = conversationWorkspace.get(String(message.conversation_id)) ?? "";
    const inbound = message.direction === "inbound";
    const recent = inbound && new Date(String(message.sent_at)).getTime() >= weekAgo;
    const sentiment = inbound ? message.sentiment ?? null : null;
    const key = JSON.stringify([workspaceId, message.direction ?? null, message.campaign ?? null, message.sender ?? null, sentiment, recent]);
    const group = messageGroups.get(key)
      ?? { workspaceId, direction: message.direction ?? null, campaign: message.campaign ?? null, sender: message.sender ?? null, sentiment, recent, count: 0, firstSeq: index };
    group.count += 1;
    messageGroups.set(key, group);
    if (inbound) {
      const sentAt = new Date(String(message.sent_at));
      if (!Number.isNaN(sentAt.getTime())) {
        const day = easternDayKey(sentAt);
        inboundByDay[day] = (inboundByDay[day] ?? 0) + 1;
      }
    }
    const thread = byConversation.get(String(message.conversation_id));
    if (thread) thread.push(message);
    else byConversation.set(String(message.conversation_id), [message]);
  });

  let responseSumMs = 0;
  let responseCount = 0;
  for (const thread of byConversation.values()) {
    let lastOutbound = 0;
    for (const message of thread) {
      const timestamp = new Date(String(message.sent_at)).getTime();
      if (message.direction === "outbound") lastOutbound = timestamp;
      else if (message.direction === "inbound" && lastOutbound && timestamp >= lastOutbound) { responseSumMs += timestamp - lastOutbound; responseCount += 1; lastOutbound = 0; }
    }
  }
  return { conversations: [...conversationGroups.values()], messages: [...messageGroups.values()], inboundByDay, responseSumMs, responseCount };
}

/**
 * The same aggregates computed inside Postgres (`supabase/migrations/20261002_rr_analytics_overview.sql`).
 *
 * Returns null when the function is not there — a database the migration has not reached — and the
 * route falls back to the row-by-row read. A missing function is remembered for a few minutes so every
 * request does not pay a 404 first.
 */
let overviewRpcMissingUntil = 0;
async function aggregateRpc(ids: string[], weekAgo: number, now: number): Promise<Aggregates | null> {
  if (Date.now() < overviewRpcMissingUntil) return null;
  const { url, key } = config();
  if (!url || !key) return null;
  try {
    const response = await fetch(`${url}/rest/v1/rpc/rr_analytics_overview`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        p_workspace_ids: ids,
        p_week_ago: new Date(weekAgo).toISOString(),
        // Comfortably before the first New York day the chart draws; only those fourteen keys are read.
        p_trend_since: new Date(now - 16 * 86_400_000).toISOString(),
      }),
      cache: "no-store",
    });
    if (response.status === 404) { overviewRpcMissingUntil = Date.now() + 5 * 60_000; return null; }
    if (!response.ok) { console.warn(`[analytics] rr_analytics_overview failed (${response.status}); reading rows instead.`); return null; }
    const payload = object(await response.json().catch(() => null));
    // Anything not shaped like this function's answer is treated as no answer at all, never as zeros.
    if (!Array.isArray(payload.conversations) || !Array.isArray(payload.messages) || !payload.inbound_by_day || typeof payload.inbound_by_day !== "object" || !payload.response || typeof payload.response !== "object") {
      console.warn("[analytics] rr_analytics_overview returned an unexpected shape; reading rows instead.");
      return null;
    }
    const list = (value: unknown) => (Array.isArray(value) ? value.map(object) : []);
    const days = object(payload.inbound_by_day);
    return {
      conversations: list(payload.conversations).map((row) => ({ workspaceId: String(row.workspace_id), tier: row.tier ?? null, count: Number(row.n ?? 0) })),
      messages: list(payload.messages).map((row) => ({
        workspaceId: String(row.workspace_id), direction: row.direction ?? null, campaign: row.campaign ?? null, sender: row.sender ?? null,
        sentiment: row.sentiment ?? null, recent: row.recent === true, count: Number(row.n ?? 0), firstSeq: Number(row.first_seq ?? 0),
      })),
      inboundByDay: Object.fromEntries(Object.entries(days).map(([day, count]) => [day, Number(count ?? 0)])),
      responseSumMs: Number(object(payload.response).sum_ms ?? 0),
      responseCount: Number(object(payload.response).n ?? 0),
    };
  } catch (error) {
    console.warn("[analytics] rr_analytics_overview unavailable; reading rows instead.", error);
    return null;
  }
}
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

type CampaignResponse = { workspace: Row; rows: Row[]; launchById: Map<string, Row>; launchByName: Map<string, Row> };

function assemble(selected: Row[], data: Aggregates, campaignResponses: CampaignResponse[], now: number) {
  let totalReplies = 0;
  let messagesSent = 0;
  let replies7d = 0;
  const perWorkspace = new Map<string, { conversations: number; replies: number; messagesSent: number }>();
  const forWorkspace = (id: string) => {
    const entry = perWorkspace.get(id) ?? { conversations: 0, replies: 0, messagesSent: 0 };
    perWorkspace.set(id, entry);
    return entry;
  };
  let activeConversations = 0;
  const queueMix = { hot: 0, warm: 0, nurture: 0 };
  for (const row of data.conversations) {
    activeConversations += row.count;
    forWorkspace(row.workspaceId).conversations += row.count;
    const tier = String(row.tier || "nurture").toLowerCase();
    if (tier === "hot" || tier === "warm" || tier === "nurture") queueMix[tier] += row.count;
  }
  // First-seen order, which is the order the old message-by-message loop met each group in.
  const messageRows = [...data.messages].sort((a, b) => a.firstSeq - b.firstSeq);
  const positiveByCampaign = new Map<string, number>();
  /**
   * Replies per campaign over the trailing week, so the campaign ranking can be read as "what is
   * working now" rather than "what has ever worked". HeyReach's own reply counts are lifetime — the
   * stats call is pinned to 2020 — so a recency window has to come from our own tables.
   */
  const recentByCampaign = new Map<string, number>();
  for (const row of messageRows) {
    if (row.direction === "inbound") {
      totalReplies += row.count;
      forWorkspace(row.workspaceId).replies += row.count;
      if (row.recent) replies7d += row.count;
      const name = String(row.campaign ?? "");
      if (name) {
        const key = `${row.workspaceId}:${name}`;
        if (String(row.sentiment ?? "").toLowerCase() === "positive") positiveByCampaign.set(key, (positiveByCampaign.get(key) ?? 0) + row.count);
        if (row.recent) recentByCampaign.set(key, (recentByCampaign.get(key) ?? 0) + row.count);
      }
    } else if (row.direction === "outbound") {
      messagesSent += row.count;
      forWorkspace(row.workspaceId).messagesSent += row.count;
    }
  }
  // Fourteen days rather than seven: a week of bars is too short to tell a slow week from a
  // trend, and the chart now has the width for it.
  //
  // Bucketed by the team's calendar day in New York. `setHours(0)` used the server's own zone, which is
  // UTC on Vercel, so every reply after 8pm Eastern (7pm in winter) landed on the next day's bar.
  const todayKey = easternDayKey(new Date(now));
  const trendDays = Array.from({ length: 14 }, (_, index) => shiftDayKey(todayKey, index - 13));
  const trend = trendDays.map((key) => data.inboundByDay[key] ?? 0);
  const trendLabels = trendDays.map((key) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`);
  /**
   * Replies per day across every client, over the trailing week.
   *
   * This used to divide every reply we hold by the age of the oldest one. That reads as a lifetime
   * average, but it is not one: the divisor grew by a day every day while the numerator only counted
   * replies still in the tables, so the figure fell forever and showed 1.5/day on a week that was
   * actually running above thirty. Backfilled history made it worse — one reply imported from six
   * months ago moved the divisor by 180 days and the numerator by one.
   *
   * Seven days fixes the denominator to something the number can be checked against by eye: it is the
   * sum of seven specific bars in the chart above, divided by seven. Days with no replies still count,
   * because a quiet Sunday is a real part of the week's rate.
   *
   * Those seven are the ones *before* today, not including it. Today is a few hours old whenever the
   * page is opened, and counting a part-day as a whole one drops the average every morning.
   */
  const completeDays = trend.slice(-8, -1);
  const averageDailyReplies = completeDays.length
    ? completeDays.reduce((sum, value) => sum + value, 0) / completeDays.length
    : 0;
  const clientLoad = selected.map((workspace) => ({ name: workspace.name, leads: perWorkspace.get(String(workspace.id))?.conversations ?? 0 }));
  const workspaceName = new Map(selected.map((row) => [String(row.id), String(row.name)]));
  const clientPerformance = selected.map((workspace) => {
    const entry = perWorkspace.get(String(workspace.id));
    return { name: workspace.name, conversations: entry?.conversations ?? 0, replies: entry?.replies ?? 0, messagesSent: entry?.messagesSent ?? 0 };
  }).sort((a, b) => b.replies - a.replies);
  const groupPerformance = (key: "campaign" | "sender") => {
    const fallback = key === "campaign" ? "Unattributed campaign" : "Unknown sender";
    const groups = new Map<string, { name: string; replies: number; messages: number; clients: Set<string> }>();
    for (const row of messageRows) {
      const name = String(row[key] ?? fallback);
      const group = groups.get(name) ?? { name, replies: 0, messages: 0, clients: new Set<string>() };
      group.messages += row.count;
      if (row.direction === "inbound") group.replies += row.count;
      group.clients.add(workspaceName.get(row.workspaceId) ?? "Unknown client");
      groups.set(name, group);
    }
    return [...groups.values()].map((group) => ({ ...group, clients: [...group.clients] })).sort((a, b) => b.replies - a.replies).slice(0, 12);
  };
  const averageResponseMinutes = data.responseCount ? Math.round(data.responseSumMs / data.responseCount / 60_000) : null;
  const campaignMetrics: CampaignMetric[] = campaignResponses.flatMap(({ workspace, rows, launchById, launchByName }) => rows.map((row) => {
    const accepted = Number(row.connectionsAccepted ?? 0);
    const replies = Number(row.totalMessageReplies ?? 0) + Number(row.totalInmailReplies ?? 0);
    const name = String(row.campaignName ?? `Campaign ${row.campaignId ?? ""}`).trim();
    const positiveReplies = positiveByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
    const campaignReplies7d = recentByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
    const hasProviderAcceptanceRate = row.connectionAcceptanceRate !== null && row.connectionAcceptanceRate !== undefined && String(row.connectionAcceptanceRate).trim() !== "";
    const providerAcceptanceRate = Number(row.connectionAcceptanceRate);
    const acceptanceRate = hasProviderAcceptanceRate && Number.isFinite(providerAcceptanceRate)
      ? providerAcceptanceRate <= 1
        ? providerAcceptanceRate * 100
        : providerAcceptanceRate
      : Number(row.connectionsSent)
        ? (accepted / Number(row.connectionsSent)) * 100
        : 0;
    const launch = launchById.get(String(row.campaignId ?? "")) ?? launchByName.get(name.toLowerCase());
    const launchedAt = launch ? String(launch.startedAt ?? launch.creationTime ?? "") : "";
    return {
      workspaceId: String(workspace.id), client: String(workspace.name), campaignId: String(row.campaignId ?? ""), name,
      connectionsSent: Number(row.connectionsSent ?? 0), connectionsAccepted: accepted,
      replies, replies7d: campaignReplies7d, messagesStarted: Number(row.totalMessageStarted ?? 0) + Number(row.totalInmailStarted ?? 0),
      acceptanceRate,
      replyRate: accepted ? replies / accepted * 100 : 0,
      positiveReplies, positiveReplyRate: accepted ? positiveReplies / accepted * 100 : 0,
      launchedAt: launchedAt || null,
      status: launch ? String(launch.status ?? "") || null : null,
    };
  }));
  const average = (key: "replyRate" | "acceptanceRate" | "positiveReplyRate") => campaignMetrics.length ? campaignMetrics.reduce((sum, row) => sum + row[key], 0) / campaignMetrics.length : 0;
  const campaignAverages = { replyRate: average("replyRate"), acceptanceRate: average("acceptanceRate"), positiveReplyRate: average("positiveReplyRate") };
  const workspaceDetails = selected.map((row) => ({ id: String(row.id), name: String(row.name), slug: String(row.slug), logoUrl: row.logo_url ? String(row.logo_url) : null, accentColor: row.accent_color ? String(row.accent_color) : null }));
  return { ok: true, status: "live", totalReplies, messagesSent, activeConversations, replies7d, trend, trendLabels, averageDailyReplies, averageResponseMinutes, campaignMetrics, campaignAverages, campaigns: groupPerformance("campaign"), senders: groupPerformance("sender"), clientPerformance, queueMix, clientLoad, workspaces: selected.map((row) => row.name), workspaceDetails };
}

/**
 * A finished answer, kept for a minute.
 *
 * The analytics page polls every thirty seconds and the home page asks for the same figures, so most
 * requests within a minute of each other would otherwise redo the whole read for the same numbers.
 * Keyed by the requested workspace set; `?fresh=1` skips the read side (and refills it). Concurrent
 * identical requests share one computation. Only successful answers are kept.
 *
 * The body is stored serialised with a hash of it as an ETag, so a poll that already holds this exact
 * answer gets a 304 and no body.
 */
const RESPONSE_TTL_MS = 60_000;
type CachedAnswer = { expires: number; body: string; etag: string; status: number };
const responseCache = new Map<string, CachedAnswer>();
const responseInFlight = new Map<string, Promise<CachedAnswer>>();

function answer(cached: CachedAnswer, request: Request) {
  const headers = { etag: cached.etag, "content-type": "application/json" };
  if (cached.status === 200 && request.headers.get("if-none-match") === cached.etag) return new Response(null, { status: 304, headers });
  return new Response(cached.body, { status: cached.status, headers });
}

async function compute(requested: string[]): Promise<CachedAnswer> {
  const finish = (body: unknown, status = 200): CachedAnswer => {
    const text = JSON.stringify(slimImages(body));
    return { expires: Date.now() + RESPONSE_TTL_MS, body: text, etag: `"${createHash("sha1").update(text).digest("base64url")}"`, status };
  };
  try {
    const workspaces = await supabase("rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext,logo_url,accent_color&slug=neq.misc&order=name.asc") ?? [];
    const selected = requested.length ? workspaces.filter((row) => requested.includes(String(row.slug))) : workspaces;
    const ids = selected.map((row) => String(row.id));
    if (!ids.length) return finish({ ok: true, status: "no_data", workspaces: [], totalReplies: 0, replies7d: 0, trend: [], trendLabels: [], averageDailyReplies: 0, queueMix: { hot: 0, warm: 0, nurture: 0 }, clientLoad: [] });
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    /*
     * HeyReach and our own tables are independent, so they are read at the same time. This used to
     * wait for every conversation and message to be paged in before the first HeyReach call went out.
     */
    const campaignResponsesPromise = Promise.all(selected.map(async (workspace) => {
      const [rows, list] = await Promise.all([
        heyReachCampaignStats(workspace).catch(() => [] as Row[]),
        heyReachCampaignList(workspace).catch(() => [] as Row[]),
      ]);
      // Launch metadata is keyed by campaign id; fall back to the name for older rows.
      const launchById = new Map<string, Row>();
      const launchByName = new Map<string, Row>();
      for (const item of list) {
        launchById.set(String(item.id), item);
        launchByName.set(String(item.name ?? "").trim().toLowerCase(), item);
      }
      return { workspace, rows, launchById, launchByName };
    }));
    const aggregatesPromise = aggregateRpc(ids, weekAgo, now).then((result) => result ?? aggregateRows(ids, weekAgo));
    const [aggregates, campaignResponses] = await Promise.all([aggregatesPromise, campaignResponsesPromise]);
    return finish(assemble(selected, aggregates, campaignResponses, now));
  } catch (error) {
    return { ...finish({ ok: false, status: "error", error: error instanceof Error ? error.message : "Analytics unavailable" }, 502), expires: 0 };
  }
}

export async function GET(request: Request) {
  const { url, key } = config();
  if (!url || !key) return slimJson({ ok: false, status: "not_configured" }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const requested = params.get("workspaces")?.split(",").filter(Boolean) ?? [];
  const fresh = params.get("fresh") === "1";
  const cacheKey = [...new Set(requested)].sort().join(",");
  const cached = responseCache.get(cacheKey);
  if (!fresh && cached && cached.expires > Date.now()) return answer(cached, request);
  let pending = fresh ? undefined : responseInFlight.get(cacheKey);
  if (!pending) {
    pending = compute(requested).then((result) => {
      if (result.status === 200) responseCache.set(cacheKey, result);
      return result;
    }).finally(() => {
      if (responseInFlight.get(cacheKey) === pending) responseInFlight.delete(cacheKey);
    });
    responseInFlight.set(cacheKey, pending);
  }
  return answer(await pending, request);
}
