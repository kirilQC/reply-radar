// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { OAUTH_ORIGIN, authorizeUrl } from "../../../../lib/hubspot-user";

/** Sends the browser to HubSpot to sign the QC Growth user in to one client's portal (session only). */

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug")?.trim() ?? "";
  if (!/^[a-z0-9-]+$/i.test(slug)) return NextResponse.json({ ok: false, error: "Which client?" }, { status: 400 });
  try {
    return NextResponse.redirect(authorizeUrl(OAUTH_ORIGIN, slug));
  } catch (error) {
    return NextResponse.redirect(`${OAUTH_ORIGIN}/onboarding/${slug}?hubspot_error=${encodeURIComponent(error instanceof Error ? error.message : "Could not start the HubSpot sign-in.")}`);
  }
}
