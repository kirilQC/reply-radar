// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { draftQuestionSet } from "../../../../lib/jev";

// Drafting reads the client's brain folder and asks Sonnet for a question set; both can take a while.
export const maxDuration = 60;

// Draft (and save) a client's question set from their QC Brain ICP and client brief.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  const result = await draftQuestionSet(slug, body?.sample);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
