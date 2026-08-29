// Temporary: inspect what status/conversation data exists per cold lead. Removed after.
import { NextResponse } from "next/server";

export const maxDuration = 60;

export async function GET() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const h = { apikey: key, Authorization: `Bearer ${key}` };
  const q = async (p: string) => { const r = await fetch(`${url}/rest/v1/${p}`, { headers: h, cache: "no-store" }); return r.ok ? await r.json() : { err: r.status, body: await r.text() }; };

  // Steadywell workspace
  const ws = "8ec56523-7157-4968-8ed7-e50bfa618f3f";
  const leads = await q(`rr_leads?select=id,name,conversation_count,linkedin_profile_url,raw_data&workspace_id=eq.${ws}&cold_campaign=not.is.null&limit=400`);
  const arr = Array.isArray(leads) ? leads : [];
  // pick one replied, one not
  const replied = arr.find((l: Record<string, unknown>) => Number((((l.raw_data as Record<string,unknown>)?.reply_radar as Record<string,unknown>)?.rollup as Record<string,unknown>)?.conversation_count ?? 0) > 0);
  const notReplied = arr.find((l: Record<string, unknown>) => !replied || l !== replied);

  const dump = async (l: Record<string, unknown> | undefined) => {
    if (!l) return null;
    const raw = (l.raw_data ?? {}) as Record<string, unknown>;
    const rr = (raw.reply_radar ?? {}) as Record<string, unknown>;
    const convos = await q(`rr_conversations?select=id,status,last_message_at,raw_data&lead_id=eq.${l.id}`);
    const cids = Array.isArray(convos) ? convos.map((c: Record<string,unknown>) => c.id) : [];
    const msgs = cids.length ? await q(`rr_messages?select=direction,sent_at,body&conversation_id=in.(${cids.join(",")})&order=sent_at.asc&limit=8`) : [];
    return {
      name: l.name,
      rawTopKeys: Object.keys(raw),
      replyRadarKeys: Object.keys(rr),
      cold_call: rr.cold_call,
      rollup: rr.rollup,
      // scan raw for anything connection/status-ish
      statusish: Object.fromEntries(Object.entries(raw).filter(([k]) => /status|connect|accept|state|stage|pending|invite|request/i.test(k))),
      convos, msgSample: msgs,
    };
  };

  return NextResponse.json({ total: arr.length, replied: await dump(replied), notReplied: await dump(notReplied) });
}
