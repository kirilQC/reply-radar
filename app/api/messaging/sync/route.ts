// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The campaign-messaging sync, as an endpoint the scheduler and the app both call.
 *
 * GET so a Vercel cron can drive the daily pass; POST so the admin save can fire an immediate first sync
 * for one client. `?workspace=<slug>` narrows it to a single client — the shape the on-paste sync uses;
 * without it, every client with a messaging doc is swept. Both verbs do the same thing and both are safe
 * to call twice: a second pass files only the tabs the first did not.
 */

import { NextResponse } from "next/server";
import { syncAllMessagingDocs, syncMessagingDocForSlug } from "../../../lib/messaging-sync";

export const maxDuration = 60;

async function run(request: Request) {
  const slug = new URL(request.url).searchParams.get("workspace")?.trim() ?? "";
  try {
    const results = slug ? [await syncMessagingDocForSlug(slug)] : await syncAllMessagingDocs();
    const filed = results.reduce((sum, result) => sum + result.filed, 0);
    return NextResponse.json({ ok: true, filed, results });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Sync failed." }, { status: 502 });
  }
}

export const GET = run;
export const POST = run;
