// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { parseCalCom } from "../../../../shared/bookings.mjs";
import { calComSignatureValid, intakeBooking, loadWorkspace, readSettings, supabaseConfig, type Parsed } from "../../../lib/booking-run";

/**
 * cal.com's booking webhook. Without `?client=` it is the shared QC cal.com, routed to clients by event name;
 * with one, that client's own. QC created the webhook with a secret it keeps; cal.com signs each post with it.
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const raw = await request.text();
  const clientId = (new URL(request.url).searchParams.get("client") ?? "").trim();
  const workspace = clientId ? await loadWorkspace(config, clientId).catch(() => null) : null;
  if (clientId && !workspace) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
  const secret = workspace ? String(workspace.calcom_secret ?? "") : String((await readSettings(config)).calcom?.secret ?? "");
  if (!calComSignatureValid(request.headers.get("x-cal-signature-256") ?? "", raw, secret)) {
    return NextResponse.json({ ok: false, error: "Bad signature." }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, error: "Not JSON." }, { status: 400 }); }
  if (String(body.triggerEvent ?? "").toUpperCase() === "PING") return NextResponse.json({ ok: true, note: "Connected." });
  const result = await intakeBooking(config, parseCalCom(body) as Parsed, "calcom", body, clientId || undefined);
  if (result.run) after(() => result.run!().catch((error) => console.error("reply_radar_booking_run_failed", { meetingId: result.meetingId, error: String(error) })));
  return NextResponse.json({ ok: result.ok, note: result.note, meetingId: result.meetingId }, { status: result.ok ? 200 : 500 });
}
