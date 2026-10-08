// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { LEMLIST_WORKSPACE_COLUMNS, channelOfActivity, ingestLemlistContact, type LemlistChannel, type LemlistWorkspace } from "../../../../../lib/lemlist-ingest";
import { alertNewReplies } from "../../../../../lib/reply-alert-run";
import { classifyLatestReply } from "../../../../../lib/reply-sentiment";

/**
 * lemlist's emailsReplied / linkedinReplied webhook for one client (registered by connectLemlist, one URL per
 * channel). The path secret is QC's, and lemlist also echoes it in the body. The body is only read for the
 * contact id: the thread is fetched from lemlist with the client's key, then handled exactly as a HeyReach
 * reply is: sentiment, then the Slack reply alert when the client has it on.
 */
// 120: the reply alert waits up to 25s for a lead's follow-up message (shared/reply-burst.mjs) before posting.
export const maxDuration = 120;

type Row = Record<string, unknown>;
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

export async function POST(request: Request, context: { params: Promise<{ slug: string; secret: string }> }) {
  const { slug, secret } = await context.params;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const lookup = await fetch(`${url}/rest/v1/rr_workspaces?select=${LEMLIST_WORKSPACE_COLUMNS}&slug=eq.${encodeURIComponent(slug)}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const workspace = ((lookup.ok ? await lookup.json() : []) as Row[])[0];
  if (!workspace || !secret || String(workspace.lemlist_webhook_secret ?? "") !== secret || !workspace.lemlist_api_key) {
    return NextResponse.json({ ok: false, error: "Unknown webhook." }, { status: 404 });
  }
  // The client's "replies are arriving" signal on the health page, as a HeyReach webhook stamps it.
  await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(String(workspace.id))}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ last_webhook_received_at: new Date().toISOString() }) }).catch(() => undefined);
  const body = object(await request.json().catch(() => ({})));
  const channel = (channelOfActivity(body.type) ?? new URL(request.url).searchParams.get("channel")) as LemlistChannel | null;
  const contactId = String(body.contactId ?? "").trim();
  if (!contactId || (channel !== "email" && channel !== "linkedin")) return NextResponse.json({ ok: true, note: "Not a reply event." });
  if (body.isThirdPartyReply === true) return NextResponse.json({ ok: true, note: "A third party answered, not the lead." });
  try {
    const result = await ingestLemlistContact({ url, key }, workspace as unknown as LemlistWorkspace, contactId, channel, body);
    console.info("reply_radar_lemlist_webhook_processed", { client: slug, type: body.type, ...result });
    if ("conversationId" in result && !workspace.offboarded_at) {
      after(() => classifyLatestReply({ url, key }, result.conversationId, slug, { workspaceName: String(workspace.name ?? "") }).catch(() => undefined));
      after(() => alertNewReplies({ url, key }, result.conversationId).catch(() => undefined));
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // A 5xx makes lemlist retry, which is what a passing failure wants.
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not store the reply." }, { status: 502 });
  }
}
