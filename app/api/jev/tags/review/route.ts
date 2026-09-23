// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { reviewCompanies } from "../../../../lib/jev";

// One Claude call for up to 15 companies against the full tag set.
export const maxDuration = 60;

// Second opinion for companies Jev left in Other or Needs review: an existing tag, a proposed new one, or neither.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  const result = await reviewCompanies(slug, Array.isArray(body?.items) ? body.items : []);
  return NextResponse.json(result, { status: result.ok ? 200 : result.rateLimited ? 429 : 502 });
}
