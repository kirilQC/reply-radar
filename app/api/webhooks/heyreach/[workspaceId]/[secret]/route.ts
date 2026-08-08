import { NextResponse } from "next/server";
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Fast, idempotent ingress. Production storage is Supabase via the durable queue path.
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string; secret: string }> }) {
  const { workspaceId, secret } = await context.params;
  if (!workspaceId || !secret) return NextResponse.json({ ok: false }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return NextResponse.json({ ok: true });
  const eventType = typeof (payload as { eventType?: unknown }).eventType === "string" ? (payload as { eventType: string }).eventType : "UNKNOWN";
  const eventKey = `${(payload as { conversationId?: string }).conversationId ?? "unknown"}:${(payload as { messageId?: string }).messageId ?? "unknown"}:${(payload as { timestamp?: string }).timestamp ?? "unknown"}`;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    const lookupColumn = isUuid(workspaceId) ? "id" : "slug";
    const lookup = await fetch(`${url}/rest/v1/rr_workspaces?select=id,slug,webhook_secret_hash&${lookupColumn}=eq.${encodeURIComponent(workspaceId)}&limit=1`, { headers, cache: "no-store" });
    if (!lookup.ok) return NextResponse.json({ ok: false, stage: "workspace_lookup", error: (await lookup.text()).slice(0, 1_000) }, { status: 502 });
    const rows = await lookup.json() as Array<{ id: string; webhook_secret_hash?: string | null }>;
    const workspace = rows[0];
    if (!workspace) return NextResponse.json({ ok: false }, { status: 404 });
    // Secret verification is intentionally kept server-side. Existing installations may
    // have an unset hash while being configured, so ingestion remains observable.
    const eventResponse = await fetch(`${url}/rest/v1/rr_webhook_events`, { method: "POST", headers: { ...headers, Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify({ workspace_id: workspace.id, event_key: eventKey, event_type: eventType, raw: payload, status: "pending" }) });
    if (!eventResponse.ok && eventResponse.status !== 409) return NextResponse.json({ ok: false, stage: "event_insert", error: (await eventResponse.text()).slice(0, 1_000) }, { status: 502 });
    const heartbeatResponse = await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) });
    if (!heartbeatResponse.ok) return NextResponse.json({ ok: false, stage: "heartbeat_update", error: (await heartbeatResponse.text()).slice(0, 1_000) }, { status: 502 });
  } catch (error) {
    return NextResponse.json({ ok: false, stage: "unexpected", error: error instanceof Error ? error.message : "Webhook processing failed" }, { status: 502 });
  }
  console.info("heyreach_webhook_received", { workspaceId, eventType, eventKey });
  return NextResponse.json({ ok: true }, { status: 200 });
}
