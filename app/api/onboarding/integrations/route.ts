// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";

/**
 * The integration references shown in the onboarding hub — for now, the meetings webhook URL a client's
 * Zapier flow posts to. Behind the password gate (it lives under a gated path, not under /api/webhooks), so
 * the secret in the URL is only ever shown to someone already logged in.
 *
 * The host is taken from the request so the URL reads as whatever domain the person is on — replyradar.dev in
 * production. When MEETINGS_WEBHOOK_SECRET is not set yet, a placeholder stands in its place so the shape of
 * the URL is still clear and it is obvious what has to be configured.
 */
export function GET(request: Request) {
  const host = request.headers.get("host") ?? "replyradar.dev";
  const proto = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const secret = (process.env.MEETINGS_WEBHOOK_SECRET ?? "").trim();
  const configured = Boolean(secret);
  const meetingsWebhookUrl = `${proto}://${host}/api/webhooks/meeting/${secret || "SET-MEETINGS_WEBHOOK_SECRET"}`;
  return NextResponse.json({ ok: true, meetings: { url: meetingsWebhookUrl, configured } });
}
