// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { ingestWebhook, enrichMeeting } from "../../../../lib/meetings";

/**
 * The booked-meetings webhook, for the Zapier flow off each client's Calendly.
 *
 * One URL for every client: the client is named inside the payload (a `client` variable), not in the URL, so
 * a single Zap step serves them all. The `[key]` in the path is a shared secret — set MEETINGS_WEBHOOK_SECRET
 * in the environment and put the same value in the webhook URL, so a stranger who guesses the path cannot file
 * fake meetings. This route sits under /api/webhooks, which the auth gate deliberately leaves open, because
 * Zapier has no login cookie; the secret is what protects it instead.
 *
 * Returns 200 on success. A payload that cannot be routed (an unknown client name, or nothing worth storing)
 * returns 4xx on purpose, so the failure shows up in Zapier's task history rather than being swallowed.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function POST(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  const secret = (process.env.MEETINGS_WEBHOOK_SECRET ?? "").trim();
  // When a secret is configured, it must match. When it is not (first setup), the endpoint still works so the
  // Zap can be tested — but that is logged, because an open meetings webhook should not be the resting state.
  if (secret) {
    if (!timingSafeEqual(String(key ?? ""), secret)) {
      return NextResponse.json({ ok: false, error: "Wrong webhook secret." }, { status: 401 });
    }
  } else {
    console.warn("reply_radar_meeting_webhook_open", { note: "MEETINGS_WEBHOOK_SECRET is not set; the meetings webhook is accepting any request." });
  }

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "Send a JSON body." }, { status: 400 });
  }
  const result = await ingestWebhook(payload);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  // Fill the empty enrichment after the 200, so the webhook stays fast (see the unified route for why).
  const meetingId = result.meeting?.id;
  if (meetingId) after(() => enrichMeeting(meetingId).catch(() => {}));
  return NextResponse.json({ ok: true, client: result.client, meetingId });
}
