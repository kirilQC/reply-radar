// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Temporary: confirm the client directory loads quickly. Removed after verifying.
import { NextResponse } from "next/server";
import { listColdCallClients } from "../../../lib/cold-calling";

export const maxDuration = 60;

export async function GET() {
  const started = Date.now();
  const clients = await listColdCallClients();
  return NextResponse.json({ ok: true, ms: Date.now() - started, count: clients.length, clients });
}
