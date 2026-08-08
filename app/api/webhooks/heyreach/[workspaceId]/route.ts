import { NextResponse } from "next/server";

const ready = (workspaceId: string) => NextResponse.json({ ok: true, webhook: "ready", workspace: workspaceId });

export async function GET(_request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  return workspaceId ? ready(workspaceId) : NextResponse.json({ ok: false }, { status: 400 });
}

export async function HEAD(_request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  return new Response(null, { status: workspaceId ? 200 : 400, headers: { "content-type": "application/json" } });
}

// Compatibility endpoint for HeyReach webhook URLs configured without a secret
// segment (…/api/webhooks/heyreach/{workspace}). The secret-bearing route remains
// available for installations that use signed URLs.
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  if (!workspaceId) return NextResponse.json({ ok: false }, { status: 400 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return ready(workspaceId);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    const lookup = await fetch(`${url}/rest/v1/rr_workspaces?select=id,slug&or=(id.eq.${encodeURIComponent(workspaceId)},slug.eq.${encodeURIComponent(workspaceId)})&limit=1`, { headers, cache: "no-store" });
    if (!lookup.ok) return NextResponse.json({ ok: false }, { status: 502 });
    const rows = await lookup.json() as Array<{ id: string }>;
    const workspace = rows[0];
    if (!workspace) return NextResponse.json({ ok: false, error: "Workspace not found." }, { status: 404 });
    const body = payload as Record<string, unknown>;
    const eventKey = `${String(body.conversationId ?? "unknown")}:${String(body.messageId ?? "unknown")}:${String(body.timestamp ?? "unknown")}`;
    const eventType = typeof body.eventType === "string" ? body.eventType : "UNKNOWN";
    const eventResponse = await fetch(`${url}/rest/v1/rr_webhook_events`, { method: "POST", headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ workspace_id: workspace.id, event_key: eventKey, event_type: eventType, raw: payload, status: "pending" }) });
    if (!eventResponse.ok && eventResponse.status !== 409) return NextResponse.json({ ok: false }, { status: 502 });
    await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) });
    console.info("heyreach_webhook_received", { workspaceId, eventType, eventKey });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch { return NextResponse.json({ ok: false }, { status: 502 }); }
}
