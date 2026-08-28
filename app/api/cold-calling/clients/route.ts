// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listColdCallClients } from "../../../lib/cold-calling";

export async function GET() {
  const clients = await listColdCallClients();
  return NextResponse.json({ ok: true, clients });
}
