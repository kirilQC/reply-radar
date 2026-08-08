import { NextResponse } from "next/server";
type Row = Record<string, unknown>;

async function query(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data as Row[] : [];
}
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
const age = (value: unknown) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(String(value)).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, conversations: [], error: "Supabase is not configured." }, { status: 503 });
  try {
    const requested = new URL(request.url).searchParams.get("workspaces")?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
    const workspaces = await query(url, key, "rr_workspaces?select=id,name,slug,accent_color");
    const selected = requested.length ? workspaces.filter((workspace) => requested.includes(String(workspace.slug))) : workspaces;
    const workspaceIds = selected.map((workspace) => String(workspace.id));
    if (!workspaceIds.length) return NextResponse.json({ ok: true, conversations: [] });
    const conversations = await query(url, key, `rr_conversations?select=*&workspace_id=in.(${workspaceIds.join(",")})&order=last_message_at.desc`);
    const leadIds = [...new Set(conversations.map((row) => String(row.lead_id)).filter(Boolean))];
    const conversationIds = conversations.map((row) => String(row.id));
    const [leads, messages] = await Promise.all([
      leadIds.length ? query(url, key, `rr_leads?select=*&id=in.(${leadIds.join(",")})`) : [],
      conversationIds.length ? query(url, key, `rr_messages?select=*&conversation_id=in.(${conversationIds.join(",")})&order=sent_at.asc`) : [],
    ]);
    const workspaceById = new Map(selected.map((row) => [String(row.id), row]));
    const leadById = new Map(leads.map((row) => [String(row.id), row]));
    const result = conversations.map((conversation) => {
      const lead = leadById.get(String(conversation.lead_id)) ?? {};
      const workspace = workspaceById.get(String(conversation.workspace_id)) ?? {};
      const thread = messages.filter((message) => message.conversation_id === conversation.id).map((message) => ({ id: message.id, body: message.body, direction: message.direction, sentAt: message.sent_at }));
      const latest = thread.at(-1);
      const name = String(lead.name || "Unknown lead");
      return { id: conversation.id, initials: initials(name), name, role: String(lead.role || lead.title || ""), company: String(lead.company || ""), profileUrl: lead.linkedin_profile_url ?? lead.profile_url ?? null, client: String(workspace.name || workspace.slug || "Unknown client"), clientSlug: workspace.slug, clientTone: String(workspace.accent_color || "#8b7cff"), score: Number(conversation.score || 0), tier: ["hot", "warm", "nurture"].includes(String(conversation.tier)) ? conversation.tier : "nurture", reason: String(conversation.score_reason || "New reply received from HeyReach."), preview: String(latest?.body || ""), age: age(conversation.last_message_at), replies: thread.filter((message) => message.direction === "inbound").length, avatar: "#3c365e", messages: thread };
    });
    return NextResponse.json({ ok: true, conversations: result });
  } catch (error) { return NextResponse.json({ ok: false, conversations: [], error: error instanceof Error ? error.message : "Inbox unavailable" }, { status: 502 }); }
}
