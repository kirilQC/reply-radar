// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { runDraft } from "../../../lib/ai-draft";

// An Anthropic draft call routinely runs past the 15s platform default; give it room (Vercel Pro allows up
// to 300s). Without this the worker's per-reply drafting was being killed and retried.
export const maxDuration = 60;

/** The inbox and the worker draft through here; the work itself is `runDraft` in app/lib/ai-draft.ts. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const result = await runDraft(body && typeof body === "object" ? body : {});
  return NextResponse.json(result.body, { status: result.status });
}
