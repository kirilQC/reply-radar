// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { getReplyRadarConfig, saveReplyRadarConfig } from "../../../../lib/onboarding";
import { syncMessagingDocForSlug } from "../../../../lib/messaging-sync";

// The Reply Radar setup panel: read the client's config, and save just those fields (not the whole row).
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const config = await getReplyRadarConfig(slug);
  if (!config) return NextResponse.json({ ok: false, error: "That client was not found." }, { status: 404 });
  return NextResponse.json({ ok: true, config });
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await saveReplyRadarConfig(slug, {
    website: body.website as string | undefined,
    messagingDoc: body.messagingDoc as string | undefined,
    slackInternal: body.slackInternal as string | undefined,
    slackExternal: body.slackExternal as string | undefined,
    airtableBaseId: body.airtableBaseId as string | undefined,
    heyreachApiKey: body.heyreachApiKey as string | undefined,
    crmProvider: body.crmProvider as string | undefined,
    crmApiKey: body.crmApiKey as string | undefined,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  // Pull the messaging doc into the brain the moment it is set, same as the admin console does.
  if (typeof body.messagingDoc === "string" && body.messagingDoc.trim()) {
    after(() => syncMessagingDocForSlug(slug).catch(() => {}));
  }
  return NextResponse.json({ ok: true });
}
