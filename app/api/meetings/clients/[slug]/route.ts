// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { getClientMeetings, addMeeting, deleteMeeting } from "../../../../lib/meetings";

// One client's booked meetings, a manual add, and a delete.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getClientMeetings(slug);
  if (!data) return NextResponse.json({ ok: false, error: "That client was not found." }, { status: 404 });
  return NextResponse.json({ ok: true, client: data.client, meetings: data.meetings });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await addMeeting(slug, body, "manual");
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, meeting: result.meeting }, { status: 201 });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const result = await deleteMeeting(String(body?.id ?? ""));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
