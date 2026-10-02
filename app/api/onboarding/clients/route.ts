// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { listOnboardingClients, addOnboardingClient } from "../../../lib/onboarding";
import { slimImages } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


// The onboarding directory: every client in the hub with its progress, and the "add new client" write.
export async function GET() {
  const clients = await listOnboardingClients();
  return slimJson({ ok: true, clients });
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const result = await addOnboardingClient({
    name: String(payload?.name ?? ""),
    logoUrl: payload?.logoUrl,
    accentColor: payload?.accentColor,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, client: result.client }, { status: 201 });
}
