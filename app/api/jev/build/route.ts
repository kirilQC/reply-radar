// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { buildFromDescription } from "../../../lib/jev";

// Reads the brain and asks Sonnet to write the setup. A long brief plus the QC Brain plus an enriched sample
// profile took the question writer past 60s, and the platform killed the request mid-build with nothing
// saved — the page kept the old questions. Same ceiling as the other model-heavy routes here.
export const maxDuration = 180;

// Turn a plain-language description into a client's Jev setup (and save it): questions for contacts, tags for companies.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  const mode = body?.mode === "companies" ? "companies" : "contacts";
  if (!slug) return NextResponse.json({ ok: false, error: "client is required." }, { status: 400 });
  const result = await buildFromDescription(slug, mode, typeof body?.description === "string" ? body.description : "", body?.sample, body?.icp);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
