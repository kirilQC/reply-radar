// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/** One deal in full: the lead, the company, the campaign, and the whole conversation. */
import { NextResponse } from "next/server";
import { getDealDetail } from "../../../../lib/deals";

export const maxDuration = 30;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getDealDetail(id);
  if (!detail) return NextResponse.json({ ok: false, error: "That deal was not found." }, { status: 404 });
  return NextResponse.json({ ok: true, ...detail });
}
