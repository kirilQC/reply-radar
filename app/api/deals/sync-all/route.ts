// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { syncAllConnectedDeals } from "../../../lib/deals";

// The nightly deals sync: pull every connected client's CRM and re-attribute. Vercel Pro's cron triggers it
// (see vercel.json); the middleware lets the cron through by its CRON_SECRET bearer. A logged-in person can
// also hit it to force a full refresh. Given the whole budget because it walks every connected client.
export const maxDuration = 300;

export async function GET() {
  const result = await syncAllConnectedDeals();
  return NextResponse.json(result);
}

export const POST = GET;
