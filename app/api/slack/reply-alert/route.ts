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
import { alertMessage, alertRetryMissed, alertTest, supabaseConfig } from "../../../lib/reply-alert-run";
import { probeChannel, slackConfigured } from "../../../lib/slack";

// A draft can take most of a minute to write when none is cached yet.
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  try {
    if (body.retryMissed === true) {
      if (!workspaceId) return NextResponse.json({ ok: false, error: "No client was named." }, { status: 400 });
      const result = await alertRetryMissed(config, workspaceId);
      return NextResponse.json({ ok: true, ...result });
    }
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

/**
 * Whether QC Bot can post in each replies channel, for the Reply alerts page. A private channel the bot was
 * never invited to is the usual reason alerts go quiet, and it is invisible until a reply fails to post.
 */
export async function GET() {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  if (!slackConfigured()) return NextResponse.json({ ok: true, channels: {} });
  const response = await fetch(`${config.url}/rest/v1/rr_workspaces?select=slug,slack_replies_channel_id&slack_replies_channel_id=not.is.null&offboarded_at=is.null`, {
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    cache: "no-store",
  });
  const rows = response.ok ? ((await response.json()) as Array<{ slug: string; slack_replies_channel_id: string }>) : [];
  const channels: Record<string, { canPost: boolean; error: string }> = {};
  for (let i = 0; i < rows.length; i += 6) {
    await Promise.all(rows.slice(i, i + 6).map(async (row) => {
      const id = String(row.slack_replies_channel_id ?? "").trim();
      if (!id) return;
      const probe = await probeChannel("replies", id).catch(() => null);
      channels[row.slug] = { canPost: Boolean(probe?.canPost), error: probe?.postError ?? "Could not check the channel." };
    }));
  }
  return NextResponse.json({ ok: true, channels });
}
