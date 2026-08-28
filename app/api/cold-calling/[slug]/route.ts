// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// One client's cold-calling view: the call list (leads sorted by ICP score, with phone + call history) and
// the client's campaigns (with how many leads are fetched/enriched and any live fetch job).
import { NextResponse } from "next/server";
import { getCallList, listCampaigns } from "../../../lib/cold-calling";

export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [list, campaigns] = await Promise.all([getCallList(slug), listCampaigns(slug)]);
  if (!list.ok) return NextResponse.json({ ok: false, error: list.error }, { status: 404 });
  return NextResponse.json({
    ok: true,
    client: list.client,
    leads: list.leads,
    campaigns: campaigns.ok ? campaigns.campaigns : [],
    campaignsError: campaigns.ok ? null : campaigns.error,
  });
}
