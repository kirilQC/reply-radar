// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// A one-shot enrichment test: open /api/cold-calling/debug?slug=<client>&campaignId=<id> in the browser and
// it runs the whole enrich path on ONE lead, reporting each step's result — so a break is visible instead of
// a silent "0 enriched". Returns no secrets, only booleans for whether keys are present.
import { NextResponse } from "next/server";
import { findMobilePhone } from "../../../lib/ai-ark-enrichment";
import { isAiArkEnrichmentEnabled } from "../../../lib/lead-identity";
import { startCampaignFetch, processColdCallJobs } from "../../../lib/cold-calling";

export const maxDuration = 120;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const slug = (params.get("slug") ?? "").trim();
  const campaignId = (params.get("campaignId") ?? "").trim();

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

  // No slug → list clients + the distinct cold-tagged campaigns, so the caller can pick one.
  if (!slug) {
    const clients = await q(`rr_workspaces?select=slug,name&order=name.asc&limit=200`);
    const tagged = await q(`rr_leads?select=cold_campaign&cold_campaign=not.is.null&limit=8000`);
    const counts: Record<string, number> = {};
    if (Array.isArray(tagged.json)) for (const row of tagged.json as Record<string, unknown>[]) { const c = String(row.cold_campaign ?? ""); if (c) counts[c] = (counts[c] ?? 0) + 1; }
    return NextResponse.json({ ok: true, env, clients: clients.json, coldCampaignCounts: counts });
  }

  // Resolve the workspace.
  const ws = await q(`rr_workspaces?select=id,name&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  const workspace = Array.isArray(ws.json) ? (ws.json as Record<string, unknown>[])[0] : null;
  if (!workspace) return NextResponse.json({ ok: false, step: "resolve workspace", ws, env });
  const workspaceId = String(workspace.id);

  const action = (params.get("action") ?? "").trim();
  const jobFilter = `workspace_id=eq.${encodeURIComponent(workspaceId)}${campaignId ? `&campaign_id=eq.${encodeURIComponent(campaignId)}` : ""}`;

  // ?action=jobs → dump the recent job rows so their status/error/counts are visible.
  if (action === "jobs") {
    const jobs = await q(`rr_cold_call_jobs?select=*&${jobFilter}&order=created_at.desc&limit=10`);
    return NextResponse.json({ ok: true, env, workspaceId, jobs: jobs.json });
  }

  // ?action=run → run the REAL job pipeline synchronously and report each step + the final job row.
  if (action === "run") {
    const started = await startCampaignFetch(slug, campaignId, "debug run");
    const origin = new URL(request.url).origin;
    const steps: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      const r = await processColdCallJobs(origin, Date.now() + 45_000);
      steps.push(r);
      if (!r.processed || r.status === "done" || r.status === "error") break;
    }
    const jobs = await q(`rr_cold_call_jobs?select=id,status,error,leads_fetched,leads_enriched,total_leads,created_at&${jobFilter}&order=created_at.desc&limit=3`);
    return NextResponse.json({ ok: true, env, started, steps, jobs: jobs.json });
  }

  // How many leads are tagged for this campaign (the exact filter the enricher uses).
  const tagFilter = campaignId ? `&cold_campaign=eq.${encodeURIComponent(campaignId)}` : "&cold_campaign=not.is.null";
  const tagCount = await q(`rr_leads?select=id&workspace_id=eq.${encodeURIComponent(workspaceId)}${tagFilter}&limit=200`);
  const tagged = Array.isArray(tagCount.json) ? tagCount.json.length : 0;

  // Compare the exact enricher SELECT against a minimal one — a 400 on one column is the whole bug.
  const base = `workspace_id=eq.${encodeURIComponent(workspaceId)}${tagFilter}&order=id.asc&limit=4`;
  const selectTests: Record<string, unknown> = {};
  for (const sel of ["id", "id,name,company,linkedin_profile_url,icp_score,raw_data", "id,company", "id,icp_score", "id,linkedin_profile_url,raw_data"]) {
    const r = await q(`rr_leads?select=${encodeURIComponent(sel)}&${base}`);
    selectTests[sel] = { status: r.status, ok: r.ok, count: Array.isArray(r.json) ? r.json.length : 0, err: r.ok ? undefined : r.json };
  }

  // The exact enrich batch query (id-cursor form).
  const batch = await q(`rr_leads?select=id,name,linkedin_profile_url,phone,raw_data&workspace_id=eq.${encodeURIComponent(workspaceId)}${tagFilter}&order=id.asc&limit=1`);
  const lead = Array.isArray(batch.json) ? (batch.json as Record<string, unknown>[])[0] : null;

  const result: Record<string, unknown> = { ok: true, env, workspaceId, taggedForCampaign: tagged, selectTests, tagQueryStatus: tagCount.status, batchQueryStatus: batch.status, batchReturned: lead ? 1 : 0 };
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
