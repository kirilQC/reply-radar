// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listColdCallClients } from "../../../lib/cold-calling";
import { slimImages } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


export async function GET() {
  const clients = await listColdCallClients();
  return slimJson({ ok: true, clients });
}
