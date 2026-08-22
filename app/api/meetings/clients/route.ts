// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listMeetingClients } from "../../../lib/meetings";

// The meetings directory: every client with its meeting count and next/last times.
export async function GET() {
  const clients = await listMeetingClients();
  return NextResponse.json({ ok: true, clients });
}
