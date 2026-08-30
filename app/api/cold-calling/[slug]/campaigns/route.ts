// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// The client's campaigns (HeyReach) with fetched/enriched counts and any live job. Split from the call-list
// route so it can load in the background — it hits the HeyReach API and is only needed for the Add-leads modal
// and job progress, not the first paint.
import { NextResponse } from "next/server";
import { listCampaigns } from "../../../../lib/cold-calling";

export const maxDuration = 60;

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const campaigns = await listCampaigns(slug);
  return NextResponse.json({ ok: campaigns.ok, campaigns: campaigns.ok ? campaigns.campaigns : [], error: campaigns.ok ? null : campaigns.error });
}
