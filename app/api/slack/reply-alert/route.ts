// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Posts a reply alert on request. Two callers:
 *
 *   { messageId }           the worker's sweep, for a reply in the last 48 hours that has no card yet
 *   { test: true, workspaceId }   Configuration's "Send a test", to the Slack test channel
 *
 * The webhook does not come through here; it calls `alertNewReplies` in process. Either way the claim in
 * app/lib/reply-alert-run.ts is what makes a reply post once.
 */

import { NextResponse } from "next/server";
import { alertMessage, alertTest, supabaseConfig } from "../../../lib/reply-alert-run";

// A draft can take most of a minute to write when none is cached yet.
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  try {
    if (body.test === true) {
      if (!workspaceId) return NextResponse.json({ ok: false, error: "Save the client first." }, { status: 400 });
      const result = await alertTest(config, workspaceId);
      const ok = result.outcome === "posted";
      return NextResponse.json({ ok, ...result, ...(ok ? {} : { error: result.reason || "Nothing was posted." }) }, { status: ok ? 200 : 409 });
    }
    if (!messageId) return NextResponse.json({ ok: false, error: "No message was named." }, { status: 400 });
    const result = await alertMessage(config, messageId);
    // Busy and skipped are normal answers for the sweep, not errors; only a failed post is.
    return NextResponse.json({ ok: result.outcome !== "failed", ...result }, { status: result.outcome === "failed" ? 502 : 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "The alert could not be posted." }, { status: 502 });
  }
}
