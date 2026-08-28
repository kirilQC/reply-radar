// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Queue a background fetch-&-enrich of one campaign's full membership. Heavy (and it spends AI Ark credits),
// so it is only ever kicked off by a person clicking "Fetch & enrich" — the worker does the actual work.
import { NextResponse, after } from "next/server";
import { startCampaignFetch, processColdCallJobs } from "../../../lib/cold-calling";

// Room to do a big first pass of the job right here, so a campaign starts processing the moment it is clicked
// rather than waiting for the worker's next cycle. The worker continues anything that does not finish in one go.
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { slug?: unknown; campaignId?: unknown; campaignName?: unknown };
  const slug = String(body?.slug ?? "").trim();
  const campaignId = String(body?.campaignId ?? "").trim();
  if (!slug || !campaignId) return NextResponse.json({ ok: false, error: "slug and campaignId are required." }, { status: 400 });
  const result = await startCampaignFetch(slug, campaignId, String(body?.campaignName ?? ""));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  // Start working immediately, in the background, so a job does not sit idle waiting for the worker's cycle.
  // Loop so several queued campaigns drain within the budget; each call advances the oldest active job.
  const origin = new URL(request.url).origin;
  after(async () => {
    const deadline = Date.now() + 250_000;
    while (Date.now() < deadline) {
      const result = await processColdCallJobs(origin, deadline).catch(() => ({ processed: false }));
      if (!result.processed) break;
    }
  });
  return NextResponse.json({ ok: true });
}
