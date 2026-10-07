// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { calendlyAuthorizeUrl } from "../../../../lib/booking-connect";
import { supabaseConfig } from "../../../../lib/booking-run";

/** "Connect with Calendly": off to Calendly's sign-in. `workspaceId` for a client's own Calendly, none for QC's. */
export async function GET(request: Request) {
  const config = supabaseConfig();
  const params = new URL(request.url).searchParams;
  const returnTo = (params.get("return") ?? "/slack").startsWith("/") ? params.get("return") ?? "/slack" : "/slack";
  if (!config) return NextResponse.redirect(new URL(`${returnTo}?calendly=${encodeURIComponent("Supabase is not configured.")}`, request.url));
  const result = await calendlyAuthorizeUrl(config, request, (params.get("workspaceId") ?? "").trim(), returnTo);
  if (!result.ok) return NextResponse.redirect(new URL(`${returnTo}${returnTo.includes("?") ? "&" : "?"}calendly=${encodeURIComponent(result.error)}`, request.url));
  return NextResponse.redirect(result.url);
}
