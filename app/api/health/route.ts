// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";

export async function GET() {
  const hasSupabase = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasHeyReach = Boolean(process.env.HEYREACH_API_BASE);
  return NextResponse.json({
    status: hasSupabase && hasAnthropic && hasHeyReach ? "ready" : "configuration_required",
    services: { supabase: hasSupabase, anthropic: hasAnthropic, heyreach: hasHeyReach },
    timestamp: new Date().toISOString(),
  });
}
