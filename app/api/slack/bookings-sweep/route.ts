// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { supabaseConfig, sweepBookings } from "../../../lib/booking-run";

/** The worker's minute-by-minute backup for booking alerts (see sweepBookings). */
export const maxDuration = 300;

export async function POST() {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  try {
    return NextResponse.json({ ok: true, ...(await sweepBookings(config)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Sweep failed." }, { status: 500 });
  }
}
