// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listBlockedLeads, unblockProfile } from "../../../lib/lead-blocklist";

/**
 * The block list, and the way off it.
 *
 * An unblock path is not optional. Blocking is one click behind one confirmation, it deletes the records
 * that would otherwise let you find the person again, and ingestion then refuses them silently — so a
 * mis-click with no way back would be unrecoverable through the app. This is the smallest surface that
 * fixes that: read the list, remove an entry.
 *
 * Unblocking does not restore anything. The conversations were deleted, and they are only rebuilt if the
 * person replies again — which is the same way they arrived the first time.
 */
export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  }
  try {
    return NextResponse.json({ ok: true, blocked: await listBlockedLeads(url, key) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not read the block list." },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  }

  // In the query string rather than a body: a profile URL is an identifier, and DELETE with a body is
  // awkward to call and awkward to log.
  const requested = new URL(request.url).searchParams.get("profileKey") ?? "";
  if (!requested.trim()) {
    return NextResponse.json({ ok: false, error: "Which profile?" }, { status: 400 });
  }

  try {
    const removed = await unblockProfile(url, key, requested);
    if (!removed) {
      return NextResponse.json({ ok: false, error: "That profile was not on the block list." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unblock failed" },
      { status: 502 },
    );
  }
}
