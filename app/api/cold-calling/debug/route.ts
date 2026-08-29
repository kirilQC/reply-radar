// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// A one-shot enrichment test: open /api/cold-calling/debug?slug=<client>&campaignId=<id> in the browser and
// it runs the whole enrich path on ONE lead, reporting each step's result — so a break is visible instead of
// a silent "0 enriched". Returns no secrets, only booleans for whether keys are present.
import { NextResponse } from "next/server";
import { findMobilePhone } from "../../../lib/ai-ark-enrichment";
import { isAiArkEnrichmentEnabled } from "../../../lib/lead-identity";

export const maxDuration = 60;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const slug = (params.get("slug") ?? "").trim();
  const campaignId = (params.get("campaignId") ?? "").trim();
  if (!slug) return NextResponse.json({ ok: false, error: "Add ?slug=<client>&campaignId=<id>" }, { status: 400 });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const h = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const q = async (path: string) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers: h, cache: "no-store" });
    const body = await r.text();
    let json: unknown = null; try { json = JSON.parse(body); } catch { json = body.slice(0, 300); }
    return { status: r.status, ok: r.ok, json };
  };

  const env = {
    aiArkKeyPresent: Boolean((process.env.AI_ARK_API_KEY ?? "").trim()),
    aiArkEnabled: isAiArkEnrichmentEnabled(),
  };

  // Resolve the workspace.
  const ws = await q(`rr_workspaces?select=id,name&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  const workspace = Array.isArray(ws.json) ? (ws.json as Record<string, unknown>[])[0] : null;
  if (!workspace) return NextResponse.json({ ok: false, step: "resolve workspace", ws, env });
  const workspaceId = String(workspace.id);

  // How many leads are tagged for this campaign (the exact filter the enricher uses).
  const tagFilter = campaignId ? `&cold_campaign=eq.${encodeURIComponent(campaignId)}` : "&cold_campaign=not.is.null";
  const tagCount = await q(`rr_leads?select=id&workspace_id=eq.${encodeURIComponent(workspaceId)}${tagFilter}&limit=200`);
  const tagged = Array.isArray(tagCount.json) ? tagCount.json.length : 0;

  // The exact enrich batch query (id-cursor form).
  const batch = await q(`rr_leads?select=id,name,linkedin_profile_url,phone,raw_data&workspace_id=eq.${encodeURIComponent(workspaceId)}${tagFilter}&order=id.asc&limit=1`);
  const lead = Array.isArray(batch.json) ? (batch.json as Record<string, unknown>[])[0] : null;

  const result: Record<string, unknown> = { ok: true, env, workspaceId, taggedForCampaign: tagged, tagQueryStatus: tagCount.status, batchQueryStatus: batch.status, batchReturned: lead ? 1 : 0 };
  if (!batch.ok) result.batchQueryError = batch.json;
  if (!tagCount.ok) result.tagQueryError = tagCount.json;
  if (!lead) { result.note = "batch query returned no lead — this is where enrichment gets nothing"; return NextResponse.json(result); }

  const leadId = String(lead.id);
  const profileUrl = String(lead.linkedin_profile_url ?? "");
  result.sampleLead = { id: leadId, name: lead.name, profileUrl, currentPhone: lead.phone ?? null };

  // Try the phone finder directly.
  if (profileUrl && env.aiArkKeyPresent) {
    const started = Date.now();
    const phone = await findMobilePhone(profileUrl);
    result.phoneFinder = { phone, ms: Date.now() - started };
  } else {
    result.phoneFinder = { skipped: !profileUrl ? "no profile url on lead" : "AI_ARK_API_KEY not set" };
  }

  // Try the write that marks the lead enriched + stores the phone.
  const raw = (lead.raw_data && typeof lead.raw_data === "object" ? lead.raw_data : {}) as Record<string, unknown>;
  const rr = (raw.reply_radar && typeof raw.reply_radar === "object" ? raw.reply_radar : {}) as Record<string, unknown>;
  const cold = (rr.cold_call && typeof rr.cold_call === "object" ? rr.cold_call : {}) as Record<string, unknown>;
  const phoneVal = (result.phoneFinder as { phone?: string })?.phone;
  const nextRaw = { ...raw, reply_radar: { ...rr, cold_call: { ...cold, enriched: true }, ...(phoneVal ? { phone: phoneVal } : {}) } };
  const patch = await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", headers: h, body: JSON.stringify({ raw_data: nextRaw }) });
  const patchBody = await patch.text();
  result.writeTest = { status: patch.status, ok: patch.ok, body: patchBody.slice(0, 400) };

  return NextResponse.json(result);
}
