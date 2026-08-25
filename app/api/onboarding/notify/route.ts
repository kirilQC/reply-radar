// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Post an onboarding update to a client's Slack channel — internal or external.
 *
 * Triggered from the onboarding checklist: when a task is ticked, the operator may send a quick "this is
 * done" to the internal channel; and a premade client-facing message may be sent to the external one.
 * Both are opt-in, one click, and require the relevant channel id to be saved on the client first.
 */
import { NextResponse } from "next/server";
import { postMessage } from "../../../lib/slack";

const config = () => ({ url: process.env.SUPABASE_URL ?? "", key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" });
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export async function POST(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 500 });

  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; target?: unknown; text?: unknown };
  const slug = str(body.slug).trim();
  const target = body.target === "external" ? "external" : "internal";
  const text = str(body.text).trim();
  if (!slug || !text) return NextResponse.json({ ok: false, error: "A client and a message are required." }, { status: 400 });

  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=slack_internal_channel_id,slack_external_channel_id&slug=eq.${encodeURIComponent(slug)}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const w = ((await response.json().catch(() => [])) as Record<string, unknown>[])[0];
  const channel = target === "external" ? str(w?.slack_external_channel_id) : str(w?.slack_internal_channel_id);
  if (!channel) {
    return NextResponse.json({ ok: false, error: `No ${target} Slack channel is set for this client.` }, { status: 400 });
  }

  try {
    await postMessage(channel, text);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Slack rejected the message." }, { status: 502 });
  }
}
