// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { bookingTest, clayTest, previewBrief, supabaseConfig } from "../../../lib/booking-run";

/**
 *   { workspaceId }  the client's latest booking, Slack part only, to the Slack test channel
 *   { clay: true }   a made-up row to the Clay table, marked test, to check its answer comes back
 *   { clay: true, workspaceId, lead: { name, email, company, title } }  that lead, with the client's name, to Clay
 *   { workspaceId, preview: true, about?, instructions? }  the pre-call brief for the latest booking, unsaved
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.clay === true) {
      // From a client's page: the lead the person typed, with that client's name in the Client column.
      const lead = body.lead && typeof body.lead === "object" ? (body.lead as Record<string, unknown>) : null;
      const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
      let client: { name: string; slug: string; id: string } | null = null;
      if (workspaceId) {
        const response = await fetch(`${config.url}/rest/v1/rr_workspaces?select=name,slug&id=eq.${encodeURIComponent(workspaceId)}&limit=1`, { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, cache: "no-store" });
        const [row] = ((await response.json().catch(() => [])) ?? []) as Array<{ name?: string; slug?: string }>;
        if (row?.name) client = { name: String(row.name), slug: String(row.slug ?? ""), id: workspaceId };
      }
      const field = (key: string) => (lead && typeof lead[key] === "string" ? String(lead[key]).trim().slice(0, 200) : "");
      if (lead && !field("name") && !field("email")) return NextResponse.json({ ok: false, error: "Add at least a name or an email." }, { status: 400 });
      const result = await clayTest(config, request, lead && client ? { name: field("name"), email: field("email"), company: field("company"), title: field("title"), client } : undefined);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    if (!workspaceId) return NextResponse.json({ ok: false, error: "No client was named." }, { status: 400 });
    if (body.preview === true) {
      const override = {
        ...(typeof body.about === "string" ? { about: body.about.trim() } : {}),
        ...(typeof body.instructions === "string" ? { instructions: body.instructions.trim() } : {}),
      };
      const result = await previewBrief(config, workspaceId, override);
      return NextResponse.json(result, { status: result.ok ? 200 : 409 });
    }
    const result = await bookingTest(config, workspaceId);
    const ok = result.outcome === "done";
    return NextResponse.json({ ok, ...result, ...(ok ? {} : { error: result.reason || "Nothing was posted." }) }, { status: ok ? 200 : 409 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "The test failed." }, { status: 500 });
  }
}
