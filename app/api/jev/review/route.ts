// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { reviewContacts } from "../../../lib/jev";

// One Claude call for up to 10 maybe contacts against the client's criteria.
export const maxDuration = 60;

// Second opinion on contacts Jev scored as "maybe": keep or drop, with a reason. Suggests only; the page applies it.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  const result = await reviewContacts(slug, Array.isArray(body?.items) ? body.items : []);
  return NextResponse.json(result, { status: result.ok ? 200 : result.rateLimited ? 429 : 502 });
}
