// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { finishCalendlyOAuth } from "../../../../../lib/booking-connect";
import { supabaseConfig } from "../../../../../lib/booking-run";

/** Calendly's redirect after sign-in. This exact URL is the Redirect URI registered on the Calendly OAuth app. */
export const maxDuration = 60;

export async function GET(request: Request) {
  const config = supabaseConfig();
  const params = new URL(request.url).searchParams;
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!config) return NextResponse.redirect(new URL("/slack?calendly=Supabase%20is%20not%20configured.", request.url));
  if (!code || !state) return NextResponse.redirect(new URL(`/slack?calendly=${encodeURIComponent(params.get("error_description") || params.get("error") || "Calendly sent no code.")}`, request.url));
  return NextResponse.redirect(new URL(await finishCalendlyOAuth(config, request, code, state), request.url));
}
