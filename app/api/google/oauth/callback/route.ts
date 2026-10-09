// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { connectGoogle, GOOGLE_ORIGIN, readGoogleState } from "../../../../lib/google-user";

/** Where Google sends QC's account back after it approves QC Command; the sign-in is kept app-wide. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const returnPath = readGoogleState(params.get("state") ?? "");
  const back = (query: string) => NextResponse.redirect(`${GOOGLE_ORIGIN}${returnPath ?? "/onboarding"}?${query}`);
  if (!returnPath) return back(`google_error=${encodeURIComponent("That Google sign-in link expired. Try Connect Google again.")}`);
  if (params.get("error")) return back(`google_error=${encodeURIComponent(params.get("error") ?? "Google sign-in was cancelled.")}`);
  try {
    await connectGoogle(params.get("code") ?? "");
    return back("google=connected");
  } catch (error) {
    return back(`google_error=${encodeURIComponent(error instanceof Error ? error.message : "Google sign-in failed.")}`);
  }
}
