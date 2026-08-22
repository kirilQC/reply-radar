// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listDealClients } from "../../../lib/deals";

// The deals directory: every client with its pipeline totals and how much traces back to QC.
export async function GET() {
  const clients = await listDealClients();
  return NextResponse.json({ ok: true, clients });
}
