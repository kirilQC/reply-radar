// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { parseCalendly } from "../../../../shared/bookings.mjs";
import { calendlySignatureValid, intakeBooking, loadWorkspace, readSettings, supabaseConfig, type Parsed } from "../../../lib/booking-run";

/**
 * Calendly's booking webhook (see app/lib/booking-run.ts). One URL for the shared QC calendar, routed by
 * event-type name; `?client=<id>` for a client connected with its own Calendly. Signed with the key QC set
 * when it subscribed, so a stranger cannot file a booking.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const raw = await request.text();
  const clientId = (new URL(request.url).searchParams.get("client") ?? "").trim();
  const signingKey = clientId
    ? String(((await loadWorkspace(config, clientId).catch(() => null))?.calendly_subscription as { signing_key?: string } | null)?.signing_key ?? "")
    : String((await readSettings(config)).calendly?.signing_key ?? "");
  if (!calendlySignatureValid(request.headers.get("calendly-webhook-signature") ?? "", raw, signingKey)) {
    return NextResponse.json({ ok: false, error: "Bad signature." }, { status: 401 });
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, error: "Not JSON." }, { status: 400 }); }
  const result = await intakeBooking(config, parseCalendly(body) as Parsed, "calendly", body, clientId || undefined);
  if (result.run) after(() => result.run!().catch((error) => console.error("reply_radar_booking_run_failed", { meetingId: result.meetingId, error: String(error) })));
  console.info("reply_radar_booking_webhook", { source: "calendly", client: result.client, note: result.note });
  return NextResponse.json({ ok: result.ok, note: result.note, meetingId: result.meetingId }, { status: result.ok ? 200 : 500 });
}
