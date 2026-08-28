// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Queue a background fetch-&-enrich of one campaign's full membership. Heavy (and it spends AI Ark credits),
// so it is only ever kicked off by a person clicking "Fetch & enrich" — the worker does the actual work.
import { NextResponse } from "next/server";
import { startCampaignFetch } from "../../../lib/cold-calling";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; campaignId?: unknown; campaignName?: unknown };
  const slug = String(body?.slug ?? "").trim();
  const campaignId = String(body?.campaignId ?? "").trim();
  if (!slug || !campaignId) return NextResponse.json({ ok: false, error: "slug and campaignId are required." }, { status: 400 });
  const result = await startCampaignFetch(slug, campaignId, String(body?.campaignName ?? ""));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
