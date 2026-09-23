// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { describeTags } from "../../../../lib/jev";

// One model call for up to 40 tag descriptions (~1.5k tokens out) — comfortably inside the ceiling.
export const maxDuration = 60;

// Write descriptions for one slice of a typed tag list. Returns them; the browser saves the whole set once.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  const labels = Array.isArray(body?.labels) ? body.labels.map(String) : [];
  const all = Array.isArray(body?.all) ? body.all.map(String) : labels;
  const result = await describeTags(slug, labels, all);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
