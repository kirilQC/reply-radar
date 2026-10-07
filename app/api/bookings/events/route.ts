// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listEvents } from "../../../lib/booking-connect";
import { supabaseConfig } from "../../../lib/booking-run";

/** Every event type on the connected calendars (plus one client's own, with ?workspaceId=). */
export const maxDuration = 60;

export async function GET(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  return NextResponse.json({ ok: true, ...(await listEvents(config, (new URL(request.url).searchParams.get("workspaceId") ?? "").trim())) });
}
