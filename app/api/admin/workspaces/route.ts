import { NextResponse } from "next/server";

function supabaseConfig() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
const webhookBaseUrl = "https://reply-radar-mauve.vercel.app";
const webhookUrlFor = (slug: unknown) => `${webhookBaseUrl}/api/webhooks/heyreach/${String(slug ?? "")}`;

export async function GET() {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  let response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,client_brief,anthropic_model,logo_url,accent_color,timezone,website_url,webhook_url,webhook_secret_hash,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext,guardrails&order=created_at.asc`, { headers, cache: "no-store" });
  // Permit the UI to keep working while the additive migration is being run.
  if (!response.ok) response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,client_brief,anthropic_model,logo_url,accent_color,webhook_url,webhook_secret_hash,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext,guardrails&order=created_at.asc`, { headers, cache: "no-store" });
  const rows = await response.json();
  const workspaces = Array.isArray(rows) ? rows.map((row) => ({ ...row, webhook_url: !row.webhook_url || String(row.webhook_url).startsWith("https://replyradar.app/") ? webhookUrlFor(row.slug) : row.webhook_url, key_configured: Boolean(row.heyreach_api_key_ciphertext), ai_ark_enrichment_enabled: Boolean(row.guardrails?.ai_ark_enrichment_enabled), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined })) : rows;
  return NextResponse.json({ ok: response.ok, workspaces, aiArkConfigured: Boolean(process.env.AI_ARK_API_KEY) }, { status: response.ok ? 200 : response.status });
}

export async function POST(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json();
  const existingGuardrails = payload.guardrails && typeof payload.guardrails === "object" && !Array.isArray(payload.guardrails) ? payload.guardrails : {};
  const record: Record<string, unknown> = { name: payload.name ?? "", slug: payload.slug, client_brief: payload.clientBrief ?? null, anthropic_model: payload.anthropicModel ?? null, logo_url: payload.logoUrl ?? null, accent_color: payload.accentColor ?? null, timezone: payload.timezone || "America/New_York", website_url: payload.websiteUrl ?? null, webhook_url: webhookUrlFor(payload.slug), guardrails: { ...existingGuardrails, ai_ark_enrichment_enabled: payload.aiArkEnrichmentEnabled === true } };
  if (typeof payload.heyreachApiKey === "string" && payload.heyreachApiKey.trim()) record.heyreach_api_key_ciphertext = payload.heyreachApiKey.trim();
  const previousSlug = typeof payload.previousSlug === "string" ? payload.previousSlug.trim() : "";
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const patchFilter = id ? `id=eq.${encodeURIComponent(id)}` : previousSlug ? `slug=eq.${encodeURIComponent(previousSlug)}` : "";
  if (patchFilter) {
    let patched = await fetch(`${url}/rest/v1/rr_workspaces?${patchFilter}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(record) });
    if (!patched.ok && (patched.status === 400 || patched.status === 422)) {
      const legacyRecord = { ...record };
      delete legacyRecord.timezone;
      delete legacyRecord.website_url;
      patched = await fetch(`${url}/rest/v1/rr_workspaces?${patchFilter}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(legacyRecord) });
    }
    const patchText = await patched.text();
    let patchData: unknown = null; try { patchData = patchText ? JSON.parse(patchText) : null; } catch { patchData = patchText; }
    if (!patched.ok) return NextResponse.json({ ok: false, error: patchData || "Workspace update failed." }, { status: patched.status });
    const rows = Array.isArray(patchData) ? patchData : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "The workspace no longer exists. Refresh and try again." }, { status: 404 });
    const workspaces = rows.map((row: Record<string, unknown>) => ({ ...row, key_configured: Boolean(row.heyreach_api_key_ciphertext), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined }));
    return NextResponse.json({ ok: true, workspaces }, { status: 200 });
  }
  let response = await fetch(`${url}/rest/v1/rr_workspaces?on_conflict=slug`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(record) });
  if (!response.ok && (response.status === 400 || response.status === 422)) {
    const legacyRecord = { ...record };
    delete legacyRecord.timezone;
    delete legacyRecord.website_url;
    response = await fetch(`${url}/rest/v1/rr_workspaces?on_conflict=slug`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(legacyRecord) });
  }
  const body = await response.text();
  let data: unknown = null; try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  const workspaces = Array.isArray(data) ? data.map((row: Record<string, unknown>) => ({ ...row, key_configured: Boolean(row.heyreach_api_key_ciphertext), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined })) : data;
  return NextResponse.json({ ok: response.ok, workspaces, error: response.ok ? undefined : data }, { status: response.ok ? 201 : response.status });
}

export async function DELETE(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({}));
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const slug = typeof payload.slug === "string" ? payload.slug.trim() : "";
  if (!id && !slug) return NextResponse.json({ ok: false, error: "Workspace id or slug is required." }, { status: 400 });
  let filter = id ? `id=eq.${encodeURIComponent(id)}` : `slug=eq.${encodeURIComponent(slug)}`;
  // Remove profile assignments first. The schema uses cascading deletes, but
  // older installations may have been created without the FK cascade.
  const workspaceLookup = await fetch(`${url}/rest/v1/rr_workspaces?${filter}&select=id`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
  let workspaceRows = await workspaceLookup.json().catch(() => []);
  if ((!Array.isArray(workspaceRows) || workspaceRows.length === 0) && slug && id) {
    filter = `slug=eq.${encodeURIComponent(slug)}`;
    const bySlug = await fetch(`${url}/rest/v1/rr_workspaces?${filter}&select=id`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
    workspaceRows = await bySlug.json().catch(() => []);
  }
  const workspaceIds = Array.isArray(workspaceRows) ? workspaceRows.map((row: { id?: string }) => row.id).filter(Boolean) : [];
  for (const workspaceId of workspaceIds) {
    await fetch(`${url}/rest/v1/rr_profile_workspaces?workspace_id=eq.${encodeURIComponent(String(workspaceId))}`, { method: "DELETE", headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=minimal" } });
  }
  const response = await fetch(`${url}/rest/v1/rr_workspaces?${filter}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "return=representation" },
  });
  const body = await response.text();
  let deleted: unknown = null;
  try { deleted = body ? JSON.parse(body) : null; } catch { deleted = null; }
  if (!response.ok) return NextResponse.json({ ok: false, error: body || "Workspace deletion failed." }, { status: response.status });
  // PostgREST returns an empty body for a successful DELETE unless the
  // installation honors return=representation. Treat that as success when
  // the lookup found a row, while still reporting a genuine no-op as 404.
  const deletedCount = Array.isArray(deleted) ? deleted.length : workspaceIds.length;
  if (deletedCount === 0) return NextResponse.json({ ok: false, error: "No workspace matched that id or slug." }, { status: 404 });
  return NextResponse.json({ ok: true, deletedCount });
}
