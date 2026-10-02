// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listMeetingClients } from "../../../lib/meetings";
import { slimImages } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


// The meetings directory: every client with its meeting count and next/last times.
export async function GET() {
  const clients = await listMeetingClients();
  return slimJson({ ok: true, clients });
}
