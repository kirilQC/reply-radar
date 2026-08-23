// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { ingestWebhook } from "../../../lib/meetings";

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

export async function POST(request: Request) {
  const secret = (process.env.MEETINGS_WEBHOOK_SECRET ?? "").trim();
  if (secret) {
    const provided = new URL(request.url).searchParams.get("secret") ?? request.headers.get("x-webhook-secret") ?? "";
    if (!timingSafeEqual(provided, secret)) {
      return NextResponse.json({ ok: false, error: "Wrong or missing webhook secret." }, { status: 401 });
    }
  }
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "Send a JSON body with at least a client field." }, { status: 400 });
  }
  const result = await ingestWebhook(payload);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, client: result.client, meetingId: result.meeting?.id });
}
