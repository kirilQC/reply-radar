import { NextResponse } from "next/server";
import { queryByIds } from "../../lib/chunk-query";

type Row = Record<string, unknown>;
type CampaignMetric = {
  workspaceId: string; client: string; campaignId: string; name: string;
  connectionsSent: number; connectionsAccepted: number; replies: number;
  messagesStarted: number; acceptanceRate: number; replyRate: number;
  positiveReplies: number; positiveReplyRate: number;
};
const campaignCache = new Map<string, { expires: number; rows: Row[] }>();
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
  const rows = Array.isArray(payload?.overallStats) ? payload.overallStats as Row[] : [];
  campaignCache.set(workspaceId, { expires: Date.now() + 5 * 60_000, rows });
  void writeSupabase("rr_sync_runs", {
    workspace_id: workspaceId, source: "heyreach", run_type: "campaign_metrics", status: "success",
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    records_seen: rows.length, records_written: rows.length,
    metadata: { overallStats: rows, fetchedAt: new Date().toISOString() },
  });
  return rows;
}

export async function GET(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, status: "not_configured" }, { status: 503 });
  const requested = new URL(request.url).searchParams.get("workspaces")?.split(",").filter(Boolean) ?? [];
  try {
    const workspaces = await supabase("rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext,logo_url,accent_color&order=name.asc") ?? [];
    const selected = requested.length ? workspaces.filter((row) => requested.includes(String(row.slug))) : workspaces;
    const ids = selected.map((row) => String(row.id));
    if (!ids.length) return NextResponse.json({ ok: true, status: "no_data", workspaces: [], totalReplies: 0, replies7d: 0, trend: [], aiArkCalls: 0, aiArkSuccesses: 0, aiArkFailures: 0, aiArkTrend: [], aiArkTrendLabels: [], aiArkByClient: [], queueMix: { hot: 0, warm: 0, nurture: 0 }, clientLoad: [] });
    const filter = (batch: string[]) => batch.map(encodeURIComponent).join(",");
    const conversations = await queryByIds(ids, 20, async (batch) =>
      (await supabase(`rr_conversations?select=id,workspace_id,score,tier,last_message_at,created_at&workspace_id=in.(${filter(batch)})&limit=1000`)) ?? [],
    );
    const conversationIdList = conversations.map((row) => String(row.id)).filter(Boolean);
    const messages = await queryByIds(conversationIdList, 20, async (batch) =>
      (await supabase(`rr_messages?select=conversation_id,direction,sent_at,raw_data&conversation_id=in.(${filter(batch)})&order=sent_at.asc`)) ?? [],
    );
    const aiArkRuns = await queryByIds(ids, 20, async (batch) =>
      (await supabase(`rr_sync_runs?select=id,workspace_id,status,started_at,finished_at,error_text&workspace_id=in.(${filter(batch)})&source=eq.ai_ark&run_type=eq.lead_enrichment&order=started_at.asc`)) ?? [],
    );
    const campaignResponses = await Promise.all(selected.map(async (workspace) => {
      try { return { workspace, rows: await heyReachCampaignStats(workspace) }; }
      catch { return { workspace, rows: [] as Row[] }; }
    }));
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const inbound = messages.filter((row) => row.direction === "inbound");
    const outbound = messages.filter((row) => row.direction === "outbound");
    const recentMessages = inbound.filter((row) => new Date(String(row.sent_at)).getTime() >= weekAgo);
    const trend = Array.from({ length: 7 }, (_, index) => {
      const dayStart = new Date(now - (6 - index) * 24 * 60 * 60 * 1000);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayStart.getDate() + 1);
      return inbound.filter((row) => {
        const timestamp = new Date(String(row.sent_at)).getTime();
        return timestamp >= dayStart.getTime() && timestamp < dayEnd.getTime();
      }).length;
    });
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
      return { name: workspace.name, conversations: conversationIds.size, replies: clientMessages.filter((row) => row.direction === "inbound").length, outbound: clientMessages.filter((row) => row.direction === "outbound").length };
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
    for (const message of inbound) {
      const radar = object(object(message.raw_data).reply_radar);
      if (String(radar.sentiment ?? "").toLowerCase() !== "positive") continue;
      const name = String(object(radar.campaign).name ?? "");
      const workspaceId = conversationWorkspace.get(String(message.conversation_id)) ?? "";
      const key = `${workspaceId}:${name}`;
      if (name) positiveByCampaign.set(key, (positiveByCampaign.get(key) ?? 0) + 1);
    }
    const campaignMetrics: CampaignMetric[] = campaignResponses.flatMap(({ workspace, rows }) => rows.map((row) => {
      const accepted = Number(row.connectionsAccepted ?? 0);
      const replies = Number(row.totalMessageReplies ?? 0) + Number(row.totalInmailReplies ?? 0);
      const name = String(row.campaignName ?? `Campaign ${row.campaignId ?? ""}`).trim();
      const positiveReplies = positiveByCampaign.get(`${String(workspace.id)}:${name}`) ?? 0;
      const hasProviderAcceptanceRate = row.connectionAcceptanceRate !== null && row.connectionAcceptanceRate !== undefined && String(row.connectionAcceptanceRate).trim() !== "";
      const providerAcceptanceRate = Number(row.connectionAcceptanceRate);
      const acceptanceRate = hasProviderAcceptanceRate && Number.isFinite(providerAcceptanceRate)
        ? providerAcceptanceRate <= 1
          ? providerAcceptanceRate * 100
          : providerAcceptanceRate
        : Number(row.connectionsSent)
          ? (accepted / Number(row.connectionsSent)) * 100
          : 0;
      return {
        workspaceId: String(workspace.id), client: String(workspace.name), campaignId: String(row.campaignId ?? ""), name,
        connectionsSent: Number(row.connectionsSent ?? 0), connectionsAccepted: accepted,
        replies, messagesStarted: Number(row.totalMessageStarted ?? 0) + Number(row.totalInmailStarted ?? 0),
        acceptanceRate,
        replyRate: accepted ? replies / accepted * 100 : 0,
        positiveReplies, positiveReplyRate: accepted ? positiveReplies / accepted * 100 : 0,
      };
    }));
    const average = (key: "replyRate" | "acceptanceRate" | "positiveReplyRate") => campaignMetrics.length ? campaignMetrics.reduce((sum, row) => sum + row[key], 0) / campaignMetrics.length : 0;
    const campaignAverages = { replyRate: average("replyRate"), acceptanceRate: average("acceptanceRate"), positiveReplyRate: average("positiveReplyRate") };
    const aiArkDays = Array.from({ length: 14 }, (_, index) => {
      const day = new Date(now - (13 - index) * 24 * 60 * 60 * 1000); day.setHours(0, 0, 0, 0); return day;
    });
    const aiArkTrend = aiArkDays.map((dayStart) => { const end = new Date(dayStart); end.setDate(dayStart.getDate() + 1); return aiArkRuns.filter((run) => { const timestamp = new Date(String(run.started_at)).getTime(); return timestamp >= dayStart.getTime() && timestamp < end.getTime(); }).length; });
    const aiArkByClient = selected.map((workspace) => {
      const runs = aiArkRuns.filter((run) => run.workspace_id === workspace.id);
      return { workspaceId: workspace.id, name: workspace.name, slug: workspace.slug, calls: runs.length, successes: runs.filter((run) => run.status === "success").length, failures: runs.filter((run) => run.status === "failed").length };
    });
    const workspaceDetails = selected.map((row) => ({ id: String(row.id), name: String(row.name), slug: String(row.slug), logoUrl: row.logo_url ? String(row.logo_url) : null, accentColor: row.accent_color ? String(row.accent_color) : null }));
    return NextResponse.json({ ok: true, status: "live", totalReplies: inbound.length, outboundMessages: outbound.length, activeConversations: conversations.length, replies7d: recentMessages.length, trend, averageResponseMinutes, campaignMetrics, campaignAverages, campaigns: groupPerformance("campaign"), senders: groupPerformance("sender"), clientPerformance, aiArkCalls: aiArkRuns.length, aiArkSuccesses: aiArkRuns.filter((run) => run.status === "success").length, aiArkFailures: aiArkRuns.filter((run) => run.status === "failed").length, aiArkTrend, aiArkTrendLabels: aiArkDays.map((day) => day.toLocaleDateString("en-US", { month: "short", day: "numeric" })), aiArkByClient, queueMix, clientLoad, workspaces: selected.map((row) => row.name), workspaceDetails });
  } catch (error) {
    return NextResponse.json({ ok: false, status: "error", error: error instanceof Error ? error.message : "Analytics unavailable" }, { status: 502 });
  }
}
