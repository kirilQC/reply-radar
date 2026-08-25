// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Re-run enrichment for one booked meeting on demand (the "Enrich" button on the meeting page). Unlike the
// webhook path, this waits for the result and hands back the refreshed meeting so the page can redraw with
// the newly-filled fields. Best effort: a meeting with no LinkedIn URL, or a person we cannot find, comes back
// unchanged with enriched:false rather than an error.
import { NextResponse } from "next/server";
import { enrichMeeting, getMeeting } from "../../../lib/meetings";

// AI Ark can take a few seconds with retries; give the request room.
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { meetingId?: unknown };
  const meetingId = String(body?.meetingId ?? "").trim();
  if (!meetingId) return NextResponse.json({ ok: false, error: "Missing meetingId." }, { status: 400 });
  const enriched = await enrichMeeting(meetingId).catch(() => false);
  const meeting = await getMeeting(meetingId);
  return NextResponse.json({ ok: true, enriched, meeting });
}
