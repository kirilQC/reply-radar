// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { ingestWebhook, enrichMeeting, latestMeetingForClient } from "../../../lib/meetings";

/**
 * The unified booked-meetings webhook — ONE URL for every client. The Zapier flow posts the meeting details
 * with a `client` field naming the client, and this routes it. No per-client URL, no secret in the path.
 *
 * A secret is optional and off by default, which is why the URL is clean. If MEETINGS_WEBHOOK_SECRET is set,
 * the request must carry it (as `?secret=…` or an `x-webhook-secret` header); if it is not set, the endpoint
 * accepts the post as-is so it works the moment you paste the URL into Zapier. (The older /meeting/<secret>
 * path still works too, for a Zap already wired that way.)
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function checkSecret(request: Request): boolean {
  const secret = (process.env.MEETINGS_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return true;
  const provided = new URL(request.url).searchParams.get("secret") ?? request.headers.get("x-webhook-secret") ?? "";
  return timingSafeEqual(provided, secret);
}

/**
 * The GET side of the same URL. Zapier posts a meeting, then a few seconds later calls GET with a `client`
 * header (or ?client=) and gets the latest booked meeting for that client back — the fully enriched person
 * and, most importantly, the campaign they came from. Same fuzzy client matching as the POST ("Ema" → "Ema
 * Health"). Returns the meeting the POST just filed, now attributed.
 */
export async function GET(request: Request) {
  if (!checkSecret(request)) return NextResponse.json({ ok: false, error: "Wrong or missing webhook secret." }, { status: 401 });
  const clientName = (request.headers.get("client") ?? new URL(request.url).searchParams.get("client") ?? "").trim();
  if (!clientName) return NextResponse.json({ ok: false, error: "Pass the client as a 'client' header (or ?client=)." }, { status: 400 });
  const result = await latestMeetingForClient(clientName);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 404 });
  if (!result.meeting) return NextResponse.json({ ok: true, client: result.client, meeting: null, campaign: null, message: "No meetings booked for this client yet." });
  return NextResponse.json({ ok: true, client: result.client, campaign: result.campaign, meeting: result.meeting });
}

export async function POST(request: Request) {
  if (!checkSecret(request)) return NextResponse.json({ ok: false, error: "Wrong or missing webhook secret." }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "Send a JSON body with at least a client field." }, { status: 400 });
  }
  const result = await ingestWebhook(payload);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  // Enrich after the 200 goes back, so Zapier gets its fast acknowledgement and the AI Ark / lead lookup
  // (which can take a few seconds) never blocks the webhook. The meeting is already saved; this only fills in
  // the empty location, headline and company block.
  const meetingId = result.meeting?.id;
  if (meetingId) after(() => enrichMeeting(meetingId).catch(() => {}));
  return NextResponse.json({ ok: true, client: result.client, meetingId });
}
