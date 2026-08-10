import { NextResponse } from "next/server";

const targetId = "a3612c60-1cc4-484e-b3f6-bee07b5a477c";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  if (payload.confirm !== "remove-john-doe-test-lead") return NextResponse.json({ ok: false }, { status: 403 });
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const inspect = await fetch(`${url}/rest/v1/rr_leads?select=id,name,linkedin_id,company&id=eq.${targetId}`, { headers, cache: "no-store" });
  const rows = await inspect.json().catch(() => []);
  const lead = Array.isArray(rows) ? rows[0] : null;
  if (!lead || lead.name !== "John Doe" || lead.linkedin_id !== "CodexBackendTest" || lead.company !== "Test Company Name") {
    return NextResponse.json({ ok: false, error: "The exact disposable test lead was not found." }, { status: 409 });
  }
  const removed = await fetch(`${url}/rest/v1/rr_leads?id=eq.${targetId}`, { method: "DELETE", headers: { ...headers, Prefer: "return=representation" } });
  const deleted = await removed.json().catch(() => []);
  return NextResponse.json({ ok: removed.ok && Array.isArray(deleted) && deleted.length === 1, deleted: Array.isArray(deleted) ? deleted.map((row) => ({ id: row.id, name: row.name })) : [] }, { status: removed.ok ? 200 : removed.status });
}
