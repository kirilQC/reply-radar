// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Save the per-client call script (auto-saved as the user types). Read back via the call-list payload.
import { NextResponse } from "next/server";
import { saveCallScript } from "../../../lib/cold-calling";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug ?? "");
  if (!slug) return NextResponse.json({ ok: false, error: "slug required" }, { status: 400 });
  const result = await saveCallScript(slug, String(body.script ?? ""));
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
