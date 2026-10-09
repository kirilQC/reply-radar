// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { GOOGLE_ORIGIN, googleAuthorizeUrl } from "../../../../lib/google-user";

/** Sends the browser to Google to sign QC's account (admin@qcgrowth.com) in to QC Command, once (session only). */
export async function GET(request: Request) {
  const back = new URL(request.url).searchParams.get("return") ?? "/onboarding";
  const returnPath = back.startsWith("/") && !back.startsWith("//") ? back : "/onboarding";
  try {
    return NextResponse.redirect(googleAuthorizeUrl(returnPath));
  } catch (error) {
    return NextResponse.redirect(`${GOOGLE_ORIGIN}${returnPath}?google_error=${encodeURIComponent(error instanceof Error ? error.message : "Could not start the Google sign-in.")}`);
  }
}
