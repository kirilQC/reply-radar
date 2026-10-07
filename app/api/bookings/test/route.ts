// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { bookingTest, clayTest, previewBrief, supabaseConfig } from "../../../lib/booking-run";

/**
 *   { workspaceId }  the client's latest booking, Slack part only, to the Slack test channel
 *   { clay: true }   a made-up row to the Clay table, marked test, to check its answer comes back
 *   { workspaceId, preview: true, about?, instructions? }  the pre-call brief for the latest booking, unsaved
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.clay === true) {
      const result = await clayTest(config, request);
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
