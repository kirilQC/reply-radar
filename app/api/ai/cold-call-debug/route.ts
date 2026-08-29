// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Temporary read-only verification: does getCallList return the enriched leads? Removed after confirming.
import { NextResponse } from "next/server";
import { getCallList, listColdCallClients } from "../../../lib/cold-calling";

export const maxDuration = 60;

export async function GET(request: Request) {
  const slug = (new URL(request.url).searchParams.get("slug") ?? "").trim();
  if (!slug) {
    const clients = await listColdCallClients();
    return NextResponse.json({ ok: true, clients });
  }
  const list = await getCallList(slug);
  const leads = list.leads ?? [];
  return NextResponse.json({
    ok: list.ok,
    error: list.error,
    count: leads.length,
    withPhone: leads.filter((l) => l.phone).length,
    sample: leads.slice(0, 5).map((l) => ({ name: l.name, phone: l.phone, icpScore: l.icpScore, activity: l.activity })),
  });
}
