// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { enrichLeadWithAiArk } from "../../../lib/ai-ark-enrichment";

type Row = Record<string, unknown>;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const leadId = String(body.leadId ?? "");
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 });

  try {
    const response = await fetch(`${url}/rest/v1/rr_leads?select=id,workspace_id,linkedin_profile_url,company,raw_data&id=eq.${encodeURIComponent(leadId)}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Lead lookup failed: ${response.status}`);
    const rows = (await response.json()) as Row[];
    const lead = rows[0];
    if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

    const profileUrl = String(lead.linkedin_profile_url ?? "").trim();
    if (!profileUrl) return NextResponse.json({ error: "Lead has no LinkedIn profile URL — enrichment requires one" }, { status: 400 });

    const existingRaw = lead.raw_data && typeof lead.raw_data === "object" ? lead.raw_data as Row : {};
    const replyRadar = existingRaw.reply_radar && typeof existingRaw.reply_radar === "object" ? existingRaw.reply_radar as Row : {};
    const saveRadar = (patch: Row) =>
      fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, {
        method: "PATCH",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ raw_data: { ...existingRaw, reply_radar: { ...replyRadar, ...patch, enrichment_attempted_at: new Date().toISOString() } } }),
        cache: "no-store",
      });

    let enrichment;
    try {
      enrichment = await enrichLeadWithAiArk({ url, key }, String(lead.workspace_id), profileUrl, String(lead.company ?? ""));
    } catch (error) {
      // Recorded on the lead rather than only returned, because AI Ark charges five attempts
      // per call and the background sweep would otherwise retry an unmatchable lead forever.
      const message = error instanceof Error ? error.message : "Enrichment failed";
      await saveRadar({ enrichment_status: "unavailable", enrichment_error: message.slice(0, 1_000) }).catch(() => null);
      return NextResponse.json({ ok: false, error: message }, { status: 502 });
    }

    await saveRadar({ ai_ark: enrichment, enrichment_status: "enriched", enrichment_error: null });

    return NextResponse.json({ ok: true, enrichment: { headline: enrichment.headline, title: enrichment.title, company: enrichment.company } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Enrichment failed" }, { status: 502 });
  }
}
