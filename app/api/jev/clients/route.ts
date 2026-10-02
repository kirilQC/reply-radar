// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listJevClients } from "../../../lib/jev";
import { slimImages } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


// The Jev directory: every client, and whether it has a question set yet.
export async function GET() {
  try {
    return slimJson({ ok: true, clients: await listJevClients() });
  } catch (error) {
    return slimJson({ ok: false, error: error instanceof Error ? error.message : "Could not list clients." }, { status: 502 });
  }
}
