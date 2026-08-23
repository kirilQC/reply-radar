// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { getOnboardingClient, deleteOnboardingClient, markAllOnboardingDone } from "../../../../lib/onboarding";

// One client's checklist, and removing a client from the hub.
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await getOnboardingClient(slug);
  if (!data) return NextResponse.json({ ok: false, error: "That client is not in the onboarding hub." }, { status: 404 });
  return NextResponse.json({ ok: true, client: data.client, tasks: data.tasks });
}

// Mark the whole client fully onboarded without checking each step.
export async function PATCH(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await markAllOnboardingDone(slug);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const result = await deleteOnboardingClient(slug);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
