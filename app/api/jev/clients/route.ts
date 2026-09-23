// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listJevClients } from "../../../lib/jev";

// The Jev directory: every client, and whether it has a question set yet.
export async function GET() {
  try {
    return NextResponse.json({ ok: true, clients: await listJevClients() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not list clients." }, { status: 502 });
  }
}
