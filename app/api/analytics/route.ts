import { NextResponse } from "next/server";

type Row = Record<string, unknown>;

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

export async function GET(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, status: "not_configured" }, { status: 503 });
  const requested = new URL(request.url).searchParams.get("workspaces")?.split(",").filter(Boolean) ?? [];
  try {
    const workspaces = await supabase("rr_workspaces?select=id,name,slug&order=name.asc") ?? [];
    const selected = requested.length ? workspaces.filter((row) => requested.includes(String(row.slug))) : workspaces;
    const ids = selected.map((row) => String(row.id));
    if (!ids.length) return NextResponse.json({ ok: true, status: "no_data", workspaces: [], totalReplies: 0, replies7d: 0, trend: [], aiArkCalls: 0, aiArkSuccesses: 0, aiArkFailures: 0, aiArkTrend: [], aiArkTrendLabels: [], queueMix: { hot: 0, warm: 0, nurture: 0 }, clientLoad: [] });
    const idFilter = ids.join(",");
    const conversations = await supabase(`rr_conversations?select=id,workspace_id,score,tier,last_message_at,created_at&workspace_id=in.(${idFilter})`) ?? [];
    const conversationIdList = conversations.map((row) => String(row.id)).filter(Boolean);
    const messages = conversationIdList.length
      ? (await supabase(`rr_messages?select=conversation_id,direction,sent_at&conversation_id=in.(${conversationIdList.join(",")})`) ?? [])
      : [];
    const aiArkRuns = await supabase(`rr_sync_runs?select=id,workspace_id,status,started_at,finished_at,error_text&workspace_id=in.(${idFilter})&source=eq.ai_ark&run_type=eq.lead_enrichment&order=started_at.asc`) ?? [];
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentMessages = messages.filter((row) => new Date(String(row.sent_at)).getTime() >= weekAgo);
    const trend = Array.from({ length: 7 }, (_, index) => {
      const dayStart = new Date(now - (6 - index) * 24 * 60 * 60 * 1000);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayStart.getDate() + 1);
      return recentMessages.filter((row) => {
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
    const aiArkDays = Array.from({ length: 14 }, (_, index) => {
      const day = new Date(now - (13 - index) * 24 * 60 * 60 * 1000); day.setHours(0, 0, 0, 0); return day;
    });
    const aiArkTrend = aiArkDays.map((dayStart) => { const end = new Date(dayStart); end.setDate(dayStart.getDate() + 1); return aiArkRuns.filter((run) => { const timestamp = new Date(String(run.started_at)).getTime(); return timestamp >= dayStart.getTime() && timestamp < end.getTime(); }).length; });
    return NextResponse.json({ ok: true, status: "live", totalReplies: messages.length, replies7d: recentMessages.length, trend, aiArkCalls: aiArkRuns.length, aiArkSuccesses: aiArkRuns.filter((run) => run.status === "success").length, aiArkFailures: aiArkRuns.filter((run) => run.status === "failed").length, aiArkTrend, aiArkTrendLabels: aiArkDays.map((day) => day.toLocaleDateString("en-US", { month: "short", day: "numeric" })), queueMix, clientLoad, workspaces: selected.map((row) => row.name) });
  } catch (error) {
    return NextResponse.json({ ok: false, status: "error", error: error instanceof Error ? error.message : "Analytics unavailable" }, { status: 502 });
  }
}
