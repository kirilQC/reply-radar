// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { syncDeals } from "../../../lib/deals";

// A CRM pull for one client is a couple of round trips to HubSpot/Attio plus per-contact reads, so give it room.
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { client?: unknown };
  const result = await syncDeals(String(body?.client ?? ""));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, synced: result.synced, confirmed: result.confirmed, possible: result.possible });
}
