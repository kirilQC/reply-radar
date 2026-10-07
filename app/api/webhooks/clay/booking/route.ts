// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { intakeClay, readSettings, secretMatches, supabaseConfig } from "../../../../lib/booking-run";

/**
 * Where the shared Clay table's last column (HTTP API, POST) sends each enriched booking. The URL, secret
 * included, rides on every row QC adds as `callback_url`, so the column can use that cell as its URL. The
 * body must carry back the row's `meeting_id`; every other field is matched by name (see fromClay).
 */
export const maxDuration = 60;

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const settings = await readSettings(config);
  const provided = new URL(request.url).searchParams.get("secret") ?? request.headers.get("x-webhook-secret") ?? "";
  if (!secretMatches(provided, String(settings.callback_secret ?? ""))) return NextResponse.json({ ok: false, error: "Wrong or missing secret." }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ ok: false, error: "Send a JSON body." }, { status: 400 });
  const result = await intakeClay(config, body);
  if (result.run) after(() => result.run!().catch((error) => console.error("reply_radar_booking_deliver_failed", String(error))));
  return NextResponse.json({ ok: result.ok, note: result.note }, { status: result.status });
}
