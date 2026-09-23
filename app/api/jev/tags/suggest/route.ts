// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { suggestTags } from "../../../../lib/jev";

// One call to a strong model over up to 250 companies; well inside the ceiling, but not instant.
export const maxDuration = 60;

// Propose new tags for the companies a run left in "Other". Suggests only — nothing is saved until someone adds them.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  const result = await suggestTags(slug, Array.isArray(body?.items) ? body.items : []);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
