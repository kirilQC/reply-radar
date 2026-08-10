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
  const workspacesResponse = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&slug=eq.bluevia&limit=1`, { headers, cache: "no-store" });
  const eventsResponse = await fetch(`${url}/rest/v1/rr_webhook_events?select=id,raw&order=received_at.desc&limit=500`, { headers, cache: "no-store" });
  const workspaces = await workspacesResponse.json().catch(() => []);
  const events = await eventsResponse.json().catch(() => []);
  const workspace = Array.isArray(workspaces) ? workspaces[0] : null;
  const event = (Array.isArray(events) ? events : []).find((row) => {
    const lead = object(object(row).raw && object(object(row).raw).lead);
    return String(lead.full_name ?? lead.fullName ?? "").trim() === "Natalie Davis";
  });
  if (!workspace || !event) return NextResponse.json({ ok: false, error: "The exact Bluevia/Natalie webhook could not be found." }, { status: 404 });
  const eventLead = object(object(event).raw && object(object(event).raw).lead);
  const campaignResponse = await fetch("https://api.heyreach.io/api/public/campaign/GetCampaignsForLead", {
    method: "POST",
    headers: { "X-API-KEY": String(object(workspace).heyreach_api_key_ciphertext ?? ""), accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ profileUrl: eventLead.profile_url ?? eventLead.profileUrl, offset: 0, limit: 100 }),
    cache: "no-store",
  });
  const campaignLookup = await campaignResponse.json().catch(() => null);
  const result = await ingestHeyReachWebhook({ url, key }, workspace, object(event).raw as Row);
  return NextResponse.json({ ok: true, eventId: object(event).id, campaignLookupStatus: campaignResponse.status, campaignLookup, result });
}
