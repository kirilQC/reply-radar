// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Log the outcome of a call: who called, the result, and their notes.
import { NextResponse } from "next/server";
import { logCall } from "../../../lib/cold-calling";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { leadId?: unknown; caller?: unknown; result?: unknown; notes?: unknown };
  const leadId = String(body?.leadId ?? "").trim();
  if (!leadId) return NextResponse.json({ ok: false, error: "leadId is required." }, { status: 400 });
  const result = await logCall(leadId, {
    caller: typeof body.caller === "string" ? body.caller : undefined,
    result: typeof body.result === "string" ? body.result : undefined,
    notes: typeof body.notes === "string" ? body.notes : undefined,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
