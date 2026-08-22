// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { getClientDeals, connectCrm } from "../../../../lib/deals";

// One client's deals and CRM state, and connecting (or updating) that client's CRM.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getClientDeals(slug);
  if (!data) return NextResponse.json({ ok: false, error: "That client was not found." }, { status: 404 });
  return NextResponse.json({ ok: true, ...data });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown; apiKey?: unknown };
  const result = await connectCrm(slug, String(body?.provider ?? ""), String(body?.apiKey ?? ""));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
