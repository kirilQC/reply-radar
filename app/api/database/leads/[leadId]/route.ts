import { NextResponse } from "next/server";
type Row = Record<string, unknown>;
async function get(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data as Row[] : [];
}
export async function GET(request: Request, context: { params: Promise<{ leadId: string }> }) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const { leadId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return NextResponse.json({ ok: false, error: "Invalid lead id." }, { status: 400 });
  try {
    const offset = Math.max(0, Number(new URL(request.url).searchParams.get("messageOffset") || 0));
    const [lead] = await get(url, key, `rr_leads?select=*&id=eq.${encodeURIComponent(leadId)}&limit=1`);
    if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });
    const [workspace] = await get(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color&id=eq.${encodeURIComponent(String(lead.workspace_id))}&limit=1`);
    const conversations = await get(url, key, `rr_conversations?select=*&lead_id=eq.${encodeURIComponent(leadId)}&order=last_message_at.desc`);
    const ids = conversations.map((conversation) => String(conversation.id));
    const batchSize = 100;
    const messages = ids.length ? await get(url, key, `rr_messages?select=*&conversation_id=in.(${ids.join(",")})&order=sent_at.desc&offset=${offset}&limit=${batchSize + 1}`) : [];
    return NextResponse.json({ ok: true, lead, workspace: workspace ?? null, conversations, messages: messages.slice(0, batchSize), hasMoreMessages: messages.length > batchSize, nextMessageOffset: messages.length > batchSize ? offset + batchSize : null });
  } catch (error) { return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Lead details unavailable" }, { status: 502 }); }
}
