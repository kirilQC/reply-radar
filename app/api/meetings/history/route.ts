// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// The conversation we already had with a booked meeting's invitee, if they are a lead we contacted. The
// meeting page loads this when a meeting is opened, so the thread that led to the booking sits right under the
// meeting details. `found:false` simply means they are not a lead in our database.
import { NextResponse } from "next/server";
import { getMeetingConversation } from "../../../lib/meetings";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { meetingId?: unknown };
  const meetingId = String(body?.meetingId ?? "").trim();
  if (!meetingId) return NextResponse.json({ ok: false, error: "Missing meetingId." }, { status: 400 });
  const conversation = await getMeetingConversation(meetingId);
  return NextResponse.json({ ok: true, ...conversation });
}
