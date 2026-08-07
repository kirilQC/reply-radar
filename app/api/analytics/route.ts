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
    const workspaces = await supabase("workspaces?select=id,name,slug") ?? [];
    const selected = requested.length ? workspaces.filter((row) => requested.includes(String(row.slug))) : workspaces;
    const ids = selected.map((row) => String(row.id));
    if (!ids.length) return NextResponse.json({ ok: true, status: "no_data", workspaces: [], totalReplies: 0, replies7d: 0, trend: [], queueMix: { hot: 0, warm: 0, nurture: 0 }, clientLoad: [] });
    const idFilter = ids.join(",");
    const conversations = await supabase(`conversations?select=id,workspace_id,score,tier,last_message_at,created_at&workspace_id=in.(${idFilter})`) ?? [];
    const conversationIdList = conversations.map((row) => String(row.id)).filter(Boolean);
    const messages = conversationIdList.length
      ? (await supabase(`messages?select=conversation_id,direction,sent_at&conversation_id=in.(${conversationIdList.join(",")})`) ?? [])
      : [];
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
    return NextResponse.json({ ok: true, status: "live", totalReplies: messages.length, replies7d: recentMessages.length, trend, queueMix, clientLoad, workspaces: selected.map((row) => row.name) });
  } catch (error) {
    return NextResponse.json({ ok: false, status: "error", error: error instanceof Error ? error.message : "Analytics unavailable" }, { status: 502 });
  }
}
