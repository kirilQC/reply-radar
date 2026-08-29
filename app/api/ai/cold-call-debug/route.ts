import { NextResponse } from "next/server";
export const maxDuration = 60;
export async function GET() {
  const url = process.env.SUPABASE_URL!; const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const q = async (p: string) => { const r = await fetch(`${url}/rest/v1/${p}`, { headers: h, cache: "no-store" }); return r.ok ? r.json() : { err: r.status }; };
  const ws = "8ec56523-7157-4968-8ed7-e50bfa618f3f";
  const jobs = await q(`rr_cold_call_jobs?select=campaign_name,status,leads_fetched,leads_enriched,total_leads,updated_at&workspace_id=eq.${ws}&order=updated_at.desc&limit=4`);
  // count leads with a phone for SW015 campaign 436009
  const withPhone = await q(`rr_leads?select=id&workspace_id=eq.${ws}&cold_campaign=eq.436009&phone=not.is.null&limit=400`);
  return NextResponse.json({ recentJobs: jobs, sw015WithPhone: Array.isArray(withPhone) ? withPhone.length : withPhone });
}
