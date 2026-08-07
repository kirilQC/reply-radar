import { NextResponse } from "next/server";

// Fast, idempotent ingress. Production storage is Supabase via the durable queue path.
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string; secret: string }> }) {
  const { workspaceId, secret } = await context.params;
  if (!workspaceId || !secret) return NextResponse.json({ ok: false }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return NextResponse.json({ ok: true });
  const eventType = typeof (payload as { eventType?: unknown }).eventType === "string" ? (payload as { eventType: string }).eventType : "UNKNOWN";
  const eventKey = `${(payload as { conversationId?: string }).conversationId ?? "unknown"}:${(payload as { messageId?: string }).messageId ?? "unknown"}:${(payload as { timestamp?: string }).timestamp ?? "unknown"}`;
  // TODO: insert raw payload into webhook_events with (workspaceId, eventKey) unique constraint,
  // then enqueue the durable hydration job. Keep this handler under 200ms.
  console.info("heyreach_webhook_received", { workspaceId, eventType, eventKey });
  return NextResponse.json({ ok: true }, { status: 200 });
}
