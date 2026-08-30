// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// One client's call list (leads sorted by ICP score, with phone + call history). Campaigns are fetched
// separately (/campaigns) because they hit the HeyReach API and would otherwise slow this first paint.
import { NextResponse } from "next/server";
import { getCallList } from "../../../lib/cold-calling";

export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const list = await getCallList(slug);
  if (!list.ok) return NextResponse.json({ ok: false, error: list.error }, { status: 404 });
  return NextResponse.json({ ok: true, client: list.client, leads: list.leads });
}
