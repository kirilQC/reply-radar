import { NextResponse } from "next/server";
import { ingestHeyReachWebhook } from "../../../../lib/heyreach-ingestion";

type JsonObject = Record<string, unknown>;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = await request.json().catch(() => ({})) as JsonObject;
  const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
  if (!eventId) return NextResponse.json({ ok: false, error: "eventId is required." }, { status: 400 });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const eventResponse = await fetch(`${url}/rest/v1/rr_webhook_events?select=id,workspace_id,status,raw&id=eq.${encodeURIComponent(eventId)}&limit=1`, { headers, cache: "no-store" });
  if (!eventResponse.ok) return NextResponse.json({ ok: false, error: (await eventResponse.text()).slice(0, 1_000) }, { status: 502 });
  const event = (await eventResponse.json() as JsonObject[])[0];
  if (!event) return NextResponse.json({ ok: false, error: "Webhook event not found." }, { status: 404 });
  if (!event.raw || typeof event.raw !== "object") return NextResponse.json({ ok: false, error: "The stored webhook has no replayable payload." }, { status: 409 });
  const workspaceResponse = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(String(event.workspace_id))}&limit=1`, { headers, cache: "no-store" });
  if (!workspaceResponse.ok) return NextResponse.json({ ok: false, error: (await workspaceResponse.text()).slice(0, 1_000) }, { status: 502 });
  const workspace = (await workspaceResponse.json() as Array<{ id: string; name?: string | null; slug?: string | null; heyreach_api_key_ciphertext?: string | null }>)[0];
  if (!workspace) return NextResponse.json({ ok: false, error: "Webhook workspace not found." }, { status: 404 });
  try {
    const result = await ingestHeyReachWebhook({ url, key }, workspace, event.raw as JsonObject);
    return NextResponse.json({ ok: true, replayedEventId: eventId, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, replayedEventId: eventId, error: error instanceof Error ? error.message : "Replay failed." }, { status: 502 });
  }
}
