// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Reveal one lead's mobile number via AI Ark's phone finder and store it at raw_data.reply_radar.phone —
// the single canonical place every surface reads (the `phone` generated column, the cold-calling list, CSV
// export). Used by the "Enrich" button next to the phone field in the lead database, and reusable anywhere.
import { NextResponse } from "next/server";
import { findMobilePhone } from "../../../lib/ai-ark-enrichment";

type Row = Record<string, unknown>;
export const maxDuration = 60;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const leadId = String(body.leadId ?? "");
  if (!leadId) return NextResponse.json({ error: "leadId is required" }, { status: 400 });

  try {
    const lookup = await fetch(`${url}/rest/v1/rr_leads?select=id,linkedin_profile_url,raw_data&id=eq.${encodeURIComponent(leadId)}&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store",
    });
    if (!lookup.ok) throw new Error(`Lead lookup failed: ${lookup.status}`);
    const lead = ((await lookup.json()) as Row[])[0];
    if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

    const raw = lead.raw_data && typeof lead.raw_data === "object" ? (lead.raw_data as Row) : {};
    const rr = raw.reply_radar && typeof raw.reply_radar === "object" ? (raw.reply_radar as Row) : {};

    // Credit-saver: never re-charge for a number we already have.
    const existing = typeof rr.phone === "string" && rr.phone.trim() ? rr.phone.trim() : "";
    if (existing) return NextResponse.json({ ok: true, phone: existing, cached: true });

    const profileUrl = String(lead.linkedin_profile_url ?? "").trim();
    if (!profileUrl) return NextResponse.json({ ok: false, error: "This lead has no LinkedIn profile URL to look up." }, { status: 400 });

    const phone = await findMobilePhone(profileUrl);
    if (!phone) {
      // Record the attempt so a "no number available" reads as a finished lookup, not an untried one.
      await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, {
        method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ raw_data: { ...raw, reply_radar: { ...rr, phone_checked_at: new Date().toISOString() } } }), cache: "no-store",
      }).catch(() => null);
      return NextResponse.json({ ok: true, phone: null, message: "No mobile number found for this lead." });
    }

    const patch = await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, {
      method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ raw_data: { ...raw, reply_radar: { ...rr, phone, phone_checked_at: new Date().toISOString() } } }), cache: "no-store",
    });
    if (!patch.ok) throw new Error(`Could not save the number: ${patch.status} ${(await patch.text().catch(() => "")).slice(0, 160)}`);

    return NextResponse.json({ ok: true, phone });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Phone lookup failed" }, { status: 502 });
  }
}
