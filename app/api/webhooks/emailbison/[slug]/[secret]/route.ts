// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { EMAIL_WORKSPACE_COLUMNS, ingestBisonReply, type EmailWorkspace } from "../../../../../lib/email-ingest";
import { alertNewReplies } from "../../../../../lib/reply-alert-run";
import { classifyLatestReply } from "../../../../../lib/reply-sentiment";

/**
 * Email Bison's "lead replied" / "lead interested" webhook for one client. The path secret is the one QC
 * generated when it registered the webhook. The body is only read for the reply's id: the reply itself is
 * fetched from Bison with the client's token (see email-ingest.ts), then handled exactly as a HeyReach reply
 * is: sentiment, then the Slack reply alert when the client has it on.
 */
export const maxDuration = 60;

type Row = Record<string, unknown>;
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

export async function POST(request: Request, context: { params: Promise<{ slug: string; secret: string }> }) {
  const { slug, secret } = await context.params;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const lookup = await fetch(`${url}/rest/v1/rr_workspaces?select=${EMAIL_WORKSPACE_COLUMNS}&slug=eq.${encodeURIComponent(slug)}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const workspace = ((lookup.ok ? await lookup.json() : []) as Row[])[0];
  if (!workspace || !secret || String(workspace.emailbison_webhook_secret ?? "") !== secret) {
    return NextResponse.json({ ok: false, error: "Unknown webhook." }, { status: 404 });
  }
  // The client's "replies are arriving" signal on the health page, as a HeyReach webhook stamps it.
  await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(String(workspace.id))}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) }).catch(() => undefined);
  const body = object(await request.json().catch(() => ({})));
  const replyId = object(object(body.data).reply).id ?? object(body.reply).id;
  if (!replyId) return NextResponse.json({ ok: true, note: "No reply in this event." });
  try {
    const result = await ingestBisonReply({ url, key }, workspace as unknown as EmailWorkspace, String(replyId));
    console.info("reply_radar_email_webhook_processed", { client: slug, event: object(body.event).type, ...result });
    if ("conversationId" in result && !workspace.offboarded_at) {
      after(() => classifyLatestReply({ url, key }, result.conversationId, slug, { workspaceName: String(workspace.name ?? "") }).catch(() => undefined));
      after(() => alertNewReplies({ url, key }, result.conversationId).catch(() => undefined));
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // A 5xx makes Bison retry (up to 5 times over a day), which is what a passing failure wants.
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not store the reply." }, { status: 502 });
  }
}
