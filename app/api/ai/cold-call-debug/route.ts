import { NextResponse } from "next/server";
import { processColdCallJobs } from "../../../lib/cold-calling";
export const maxDuration = 300;
export async function GET(request: Request) {
  const origin = new URL(request.url).origin;
  const steps: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await processColdCallJobs(origin, Date.now() + 20_000);
    steps.push(r);
    if (!r.processed || r.status === "done" || r.status === "error") break;
  }
  return NextResponse.json({ ok: true, pokes: steps.length, last: steps[steps.length - 1], steps });
}
