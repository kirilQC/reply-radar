// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listDealClients } from "../../../lib/deals";
import { slimImages } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


// The deals directory: every client with its pipeline totals and how much traces back to QC.
export async function GET() {
  const clients = await listDealClients();
  return slimJson({ ok: true, clients });
}
