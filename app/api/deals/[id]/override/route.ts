// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/** Record a human's review of a deal's QC attribution — dismiss it, or restore it. */
import { NextResponse } from "next/server";
import { setDealOverride } from "../../../../lib/deals";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { override?: unknown };
  const override = body.override === "dismissed" ? "dismissed" : body.override === "confirmed" ? "confirmed" : null;
  const result = await setDealOverride(id, override);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, override });
}
