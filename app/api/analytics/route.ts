// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { queryByIds } from "../../lib/chunk-query";
import { ourCampaigns } from "../../../shared/campaign-code.mjs";

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
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const attribution = (row: Row) => {
  const radar = object(object(row.raw_data).reply_radar);
  return { campaign: String(object(radar.campaign).name ?? "Unattributed campaign"), sender: String(object(radar.sender).name ?? "Unknown sender") };
};

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

async function supabase(path: string) {
  const { url, key } = config();
  if (!url || !key) return null;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return (await response.json()) as Row[];
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
 */
async function supabaseAll(path: string, pageSize = 1000): Promise<Row[]> {
  const all: Row[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += pageSize) {
    const page = await supabase(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    if (!page || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

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

export async function GET(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, status: "not_configured" }, { status: 503 });
  const requested = new URL(request.url).searchParams.get("workspaces")?.split(",").filter(Boolean) ?? [];
  try {
    const workspaces = await supabase("rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext,logo_url,accent_color&order=name.asc") ?? [];
    const selected = requested.length ? workspaces.filter((row) => requested.includes(String(row.slug))) : workspaces;
    const ids = selected.map((row) => String(row.id));
    if (!ids.length) return NextResponse.json({ ok: true, status: "no_data", workspaces: [], totalReplies: 0, replies7d: 0, trend: [], trendLabels: [], averageDailyReplies: 0, queueMix: { hot: 0, warm: 0, nurture: 0 }, clientLoad: [] });
    const filter = (batch: string[]) => batch.map(encodeURIComponent).join(",");
    // Every conversation, paged in full — never the first 1000. An explicit order keeps the offset windows
    // stable across pages; without it the pages could overlap or skip, and a truncated list here is what
    // dropped the newest threads (and their recent replies) from the whole page.
    const conversations = await queryByIds(ids, 20, async (batch) =>
      (await supabaseAll(`rr_conversations?select=id,workspace_id,score,tier,last_message_at,created_at&workspace_id=in.(${filter(batch)})&order=id.asc`)) ?? [],
    );
    const conversationIdList = conversations.map((row) => String(row.id)).filter(Boolean);
    // Every message of those conversations, paged in full — a large batch used to lose its newest messages
    // to the 1000-row cap under `sent_at.asc`.
    const messages = await queryByIds(conversationIdList, 20, async (batch) =>
      (await supabaseAll(`rr_messages?select=conversation_id,direction,sent_at,raw_data&conversation_id=in.(${filter(batch)})&order=sent_at.asc,id.asc`)) ?? [],
    );
    const campaignResponses = await Promise.all(selected.map(async (workspace) => {
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
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const inbound = messages.filter((row) => row.direction === "inbound");
    const outbound = messages.filter((row) => row.direction === "outbound");
    const recentMessages = inbound.filter((row) => new Date(String(row.sent_at)).getTime() >= weekAgo);
    // Fourteen days rather than seven: a week of bars is too short to tell a slow week from a
    // trend, and the chart now has the width for it.
    const trendDays = Array.from({ length: 14 }, (_, index) => {
      const dayStart = new Date(now - (13 - index) * 24 * 60 * 60 * 1000);
      dayStart.setHours(0, 0, 0, 0);
      return dayStart;
    });
    const trend = trendDays.map((dayStart) => {
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayStart.getDate() + 1);
      return inbound.filter((row) => {
        const timestamp = new Date(String(row.sent_at)).getTime();
        return timestamp >= dayStart.getTime() && timestamp < dayEnd.getTime();
      }).length;
    });
    const trendLabels = trendDays.map((day) => day.toLocaleDateString("en-US", { month: "numeric", day: "numeric" }));
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
    const queueMix = conversations.reduce<{ hot: number; warm: number; nurture: number }>((result, row) => {
      const tier = String(row.tier || "nurture").toLowerCase();
      if (tier === "hot" || tier === "warm" || tier === "nurture") result[tier] += 1;
      return result;
    }, { hot: 0, warm: 0, nurture: 0 });
    const clientLoad = selected.map((workspace) => ({ name: workspace.name, leads: conversations.filter((row) => row.workspace_id === workspace.id).length }));
    const conversationWorkspace = new Map(conversations.map((row) => [String(row.id), String(row.workspace_id)]));
    const workspaceName = new Map(selected.map((row) => [String(row.id), String(row.name)]));
    const clientPerformance = selected.map((workspace) => {
      const conversationIds = new Set(conversations.filter((row) => row.workspace_id === workspace.id).map((row) => String(row.id)));
      const clientMessages = messages.filter((row) => conversationIds.has(String(row.conversation_id)));
      return { name: workspace.name, conversations: conversationIds.size, replies: clientMessages.filter((row) => row.direction === "inbound").length, messagesSent: clientMessages.filter((row) => row.direction === "outbound").length };
    }).sort((a, b) => b.replies - a.replies);
    const groupPerformance = (key: "campaign" | "sender") => {
      const groups = new Map<string, { name: string; replies: number; messages: number; clients: Set<string> }>();
      for (const message of messages) {
        const name = attribution(message)[key];
        const group = groups.get(name) ?? { name, replies: 0, messages: 0, clients: new Set<string>() };
        group.messages += 1;
        if (message.direction === "inbound") group.replies += 1;
        group.clients.add(workspaceName.get(conversationWorkspace.get(String(message.conversation_id)) ?? "") ?? "Unknown client");
        groups.set(name, group);
      }
      return [...groups.values()].map((group) => ({ ...group, clients: [...group.clients] })).sort((a, b) => b.replies - a.replies).slice(0, 12);
    };
    const responseTimes: number[] = [];
    const byConversation = new Map<string, Row[]>();
    for (const message of messages) byConversation.set(String(message.conversation_id), [...(byConversation.get(String(message.conversation_id)) ?? []), message]);
    for (const thread of byConversation.values()) {
      let lastOutbound = 0;
      for (const message of thread) {
        const timestamp = new Date(String(message.sent_at)).getTime();
        if (message.direction === "outbound") lastOutbound = timestamp;
        else if (message.direction === "inbound" && lastOutbound && timestamp >= lastOutbound) { responseTimes.push(timestamp - lastOutbound); lastOutbound = 0; }
      }
    }
    const averageResponseMinutes = responseTimes.length ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length / 60_000) : null;
    const positiveByCampaign = new Map<string, number>();
    /**
     * Replies per campaign over the trailing week, so the campaign ranking can be read as "what is
     * working now" rather than "what has ever worked". HeyReach's own reply counts are lifetime — the
     * stats call is pinned to 2020 — so a recency window has to come from our own tables.
     */
    const recentByCampaign = new Map<string, number>();
    for (const message of inbound) {
      const radar = object(object(message.raw_data).reply_radar);
      const name = String(object(radar.campaign).name ?? "");
      if (!name) continue;
      const workspaceId = conversationWorkspace.get(String(message.conversation_id)) ?? "";
      const key = `${workspaceId}:${name}`;
      if (String(radar.sentiment ?? "").toLowerCase() === "positive") {
        positiveByCampaign.set(key, (positiveByCampaign.get(key) ?? 0) + 1);
      }
      if (new Date(String(message.sent_at)).getTime() >= weekAgo) {
        recentByCampaign.set(key, (recentByCampaign.get(key) ?? 0) + 1);
      }
    }
    const campaignMetrics: CampaignMetric[] = campaignResponses.flatMap(({ workspace, rows, launchById, launchByName }) => rows.map((row) => {
      const accepted = Number(row.connectionsAccepted ?? 0);
      const replies = Number(row.totalMessageReplies ?? 0) + Number(row.totalInmailReplies ?? 0);
      const name = String(row.campaignName ?? `Campaign ${row.campaignId ?? ""}`).trim();
      const positiveReplies = positiveByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
      const replies7d = recentByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
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
        replies, replies7d, messagesStarted: Number(row.totalMessageStarted ?? 0) + Number(row.totalInmailStarted ?? 0),
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
    return NextResponse.json({ ok: true, status: "live", totalReplies: inbound.length, messagesSent: outbound.length, activeConversations: conversations.length, replies7d: recentMessages.length, trend, trendLabels, averageDailyReplies, averageResponseMinutes, campaignMetrics, campaignAverages, campaigns: groupPerformance("campaign"), senders: groupPerformance("sender"), clientPerformance, queueMix, clientLoad, workspaces: selected.map((row) => row.name), workspaceDetails });
  } catch (error) {
    return NextResponse.json({ ok: false, status: "error", error: error instanceof Error ? error.message : "Analytics unavailable" }, { status: 502 });
  }
}
