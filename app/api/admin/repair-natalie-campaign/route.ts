import { NextResponse } from "next/server";
import { ingestHeyReachWebhook } from "../../../lib/heyreach-ingestion";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  if (payload.confirm !== "repair-natalie-campaign") return NextResponse.json({ ok: false }, { status: 403 });
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const [workspacesResponse, eventsResponse, duplicateResponse] = await Promise.all([
    fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&slug=eq.bluevia&limit=1`, { headers, cache: "no-store" }),
    fetch(`${url}/rest/v1/rr_webhook_events?select=id,raw&order=received_at.desc&limit=500`, { headers, cache: "no-store" }),
    fetch(`${url}/rest/v1/rr_conversations?id=eq.e1bff623-c79b-4424-8348-d4f19f14c5ed&select=id,lead_id`, { headers, cache: "no-store" }),
  ]);
  const workspaces = await workspacesResponse.json().catch(() => []);
  const events = await eventsResponse.json().catch(() => []);
  const duplicates = await duplicateResponse.json().catch(() => []);
  const workspace = Array.isArray(workspaces) ? workspaces[0] : null;
  const event = (Array.isArray(events) ? events : []).find((row) => String(object(object(row).raw).lead && object(object(object(row).raw).lead).full_name).trim() === "Natalie Davis");
  const duplicate = Array.isArray(duplicates) ? duplicates[0] : null;
  if (!workspace || !event || object(duplicate).lead_id !== "8765a482-e843-4020-ad67-816e607a178b") return NextResponse.json({ ok: false, error: "Repair targets did not match exactly." }, { status: 409 });
  const result = await ingestHeyReachWebhook({ url, key }, workspace, object(event).raw as Row);
  const deletion = await fetch(`${url}/rest/v1/rr_conversations?id=eq.e1bff623-c79b-4424-8348-d4f19f14c5ed`, { method: "DELETE", headers: { ...headers, Prefer: "return=representation" } });
  if (!deletion.ok) return NextResponse.json({ ok: false, error: "Duplicate conversation cleanup failed." }, { status: 502 });
  return NextResponse.json({ ok: true, result, removedDuplicate: true });
}
