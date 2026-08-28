// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// The worker pokes this each cycle to advance the oldest active cold-call fetch/enrich job. It does as much
// as it can inside the function budget (fetching campaign leads, then enriching them with profile + phone +
// ICP score), and a job that does not finish is picked up on the next poke. Authorised by the CRON_SECRET
// bearer, the same way the brief cron is.
import { NextResponse } from "next/server";
import { processColdCallJobs } from "../../../lib/cold-calling";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Kept under the worker's call timeout so each poke returns cleanly; an unfinished job resumes next cycle.
  const deadlineMs = Date.now() + 80_000;
  const origin = new URL(request.url).origin;
  const result = await processColdCallJobs(origin, deadlineMs);
  return NextResponse.json({ ok: true, ...result });
}

export const GET = POST;
