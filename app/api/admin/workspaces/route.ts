// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { isAiArkEnrichmentEnabled } from "../../../lib/lead-identity";
import { writeAuditEvent } from "../../../lib/audit-log";
import { isOurWebhookUrl, publicBaseUrl, webhookUrlFor } from "../../../lib/public-url";
import { normalizeChannelId } from "../../../lib/slack-channel";
import { syncMessagingDocForSlug } from "../../../lib/messaging-sync";

/**
 * The moment a client's messaging doc is present on a saved workspace, pull its tabs into the brain.
 *
 * Fired through `after` so the save responds immediately and the sync — a Docs read plus a few GitHub
 * writes — runs on the tail of the same invocation. It is deliberately unconditional on the URL having
 * *changed*: the sync files only net-new tabs, so re-running it on an unrelated save is cheap and cannot
 * duplicate anything. Failures are swallowed here on purpose — a messaging doc that will not open must
 * never turn a workspace save into an error.
 */
function fileMessagingAfterSave(slug: string, guardrails: Record<string, unknown>): void {
  if (!slug || !String(guardrails?.messaging_doc_url ?? "").trim()) return;
  after(() => syncMessagingDocForSlug(slug).catch(() => {}));
}

function supabaseConfig() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

export async function GET(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  let response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,client_brief,anthropic_model,custom_system_prompt,logo_url,accent_color,timezone,website_url,brain_folder,slack_internal_channel_id,slack_external_channel_id,slack_extra_channel_ids,granola_title_match,granola_extra_title_matches,airtable_base_id,clay_dnc_webhook_url,morning_brief_enabled,webhook_url,webhook_secret_hash,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext,guardrails&order=name.asc`, { headers, cache: "no-store" });
  // Permit the UI to keep working while the additive migration is being run.
  if (!response.ok) response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,client_brief,anthropic_model,logo_url,accent_color,webhook_url,webhook_secret_hash,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext,guardrails&order=name.asc`, { headers, cache: "no-store" });
  const rows = await response.json();
  // Recomputed, not just read: a workspace configured before the domain moved holds the old address,
  // and the address is the one thing on this screen that somebody copies into another company's
  // dashboard. Anything already pointing at us is left exactly as it is.
  const base = publicBaseUrl(request);
  const workspaces = Array.isArray(rows) ? rows.map((row) => ({ ...row, webhook_url: isOurWebhookUrl(row.webhook_url, base) ? row.webhook_url : webhookUrlFor(row.slug, request), key_configured: Boolean(row.heyreach_api_key_ciphertext), ai_ark_enrichment_enabled: Boolean(row.guardrails?.ai_ark_enrichment_enabled), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined })) : rows;
  return NextResponse.json({ ok: response.ok, workspaces, aiArkConfigured: Boolean(process.env.AI_ARK_API_KEY), aiArkEnrichmentEnabled: isAiArkEnrichmentEnabled() }, { status: response.ok ? 200 : response.status });
}

export async function POST(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json();
  const existingGuardrails = payload.guardrails && typeof payload.guardrails === "object" && !Array.isArray(payload.guardrails) ? payload.guardrails : {};
  const record: Record<string, unknown> = { name: payload.name ?? "", slug: payload.slug, brain_folder: payload.brainFolder || null, client_brief: payload.clientBrief ?? null, anthropic_model: payload.anthropicModel ?? null, custom_system_prompt: payload.systemPrompt ?? null, logo_url: payload.logoUrl ?? null, accent_color: payload.accentColor ?? null, timezone: payload.timezone || "America/New_York", website_url: payload.websiteUrl ?? null, webhook_url: webhookUrlFor(payload.slug, request), guardrails: existingGuardrails };
  // Absent means "leave alone", not "clear". Every other field here is sent by the one form that owns
  // it, but the theme panel auto-saves a partial payload of its own, and a channel id silently emptied
  // by a logo upload would not be noticed until a Monday brief went nowhere. Normalised on the way in
  // rather than on the way out, because pasting the URL out of the address bar is the common case.
  if ("slackInternalChannelId" in payload) record.slack_internal_channel_id = normalizeChannelId(payload.slackInternalChannelId) || null;
  if ("slackExternalChannelId" in payload) record.slack_external_channel_id = normalizeChannelId(payload.slackExternalChannelId) || null;
  // Stored as the cleaned list rather than as typed, so the same string is matched against whether it
  // arrived as "@webrix.ai, foo@webrix.ai" or a comma-free paste. Anything that is not a domain is dropped
  // here instead of quietly matching every meeting at brief time.
  // Stored as typed, minus surrounding space. There is no validation to do: any word somebody puts in a
  // calendar invite is a legitimate thing to match on, and blank means "use the client's name".
  if ("granolaTitleMatch" in payload) record.granola_title_match = String(payload.granolaTitleMatch ?? "").trim() || null;
  /*
   * The extras, as arrays rather than as one comma-separated field.
   *
   * A blank row in the form is a row somebody is about to type into, not an instruction to match every
   * meeting, so blanks are dropped here rather than stored and dropped again at brief time. Sent as `[]`
   * rather than `null` when empty, because the columns are `not null default '{}'` and reading them as a
   * list everywhere is what keeps `gatherChannels` from having to guess.
   */
  const asStringList = (value: unknown, clean: (entry: string) => string) =>
    [...new Set((Array.isArray(value) ? value : []).map((entry) => clean(String(entry ?? ""))).filter(Boolean))];
  if ("slackExtraChannelIds" in payload) record.slack_extra_channel_ids = asStringList(payload.slackExtraChannelIds, (entry) => normalizeChannelId(entry));
  if ("granolaExtraTitleMatches" in payload) record.granola_extra_title_matches = asStringList(payload.granolaExtraTitleMatches, (entry) => entry.trim());
  // Validated rather than trusted, and cleared to null rather than to "". This id is the address the
  // brief will one day write client action items to, so the two failures worth stopping here are a
  // half-pasted id that would 404 every morning, and a blank that reads as "no Airtable" but stores a
  // value. Anything that is not the shape of a base id is refused outright instead of being saved and
  // discovered later by a push that went nowhere.
  if ("airtableBaseId" in payload) {
    const baseId = String(payload.airtableBaseId ?? "").trim();
    if (baseId && !/^app[A-Za-z0-9]{14}$/.test(baseId)) {
      return NextResponse.json({ ok: false, error: "That is not an Airtable base id. It starts with app and is 17 characters." }, { status: 400 });
    }
    record.airtable_base_id = baseId || null;
  }
  // The client's Clay DNC table webhook URL. Stored as typed (trimmed), cleared to null when blank. Only a
  // Clay webhook host is accepted, so a mis-pasted value fails here rather than silently swallowing DNC pushes.
  if ("clayDncWebhookUrl" in payload) {
    const dncUrl = String(payload.clayDncWebhookUrl ?? "").trim();
    if (dncUrl && !/^https:\/\/(api\.clay\.com|.*\.clay\.com)\//i.test(dncUrl)) {
      return NextResponse.json({ ok: false, error: "That does not look like a Clay webhook URL (it should start with https://api.clay.com/)." }, { status: 400 });
    }
    record.clay_dnc_webhook_url = dncUrl || null;
  }
  if (typeof payload.heyreachApiKey === "string" && payload.heyreachApiKey.trim()) record.heyreach_api_key_ciphertext = payload.heyreachApiKey.trim();
  const previousSlug = typeof payload.previousSlug === "string" ? payload.previousSlug.trim() : "";
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const create = payload.create === true;
  const patchFilter = create ? "" : id ? `id=eq.${encodeURIComponent(id)}` : previousSlug ? `slug=eq.${encodeURIComponent(previousSlug)}` : "";
  if (patchFilter) {
    let patched = await fetch(`${url}/rest/v1/rr_workspaces?${patchFilter}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(record) });
    if (!patched.ok && (patched.status === 400 || patched.status === 422)) {
      const legacyRecord = { ...record };
      delete legacyRecord.timezone;
      delete legacyRecord.website_url;
      delete legacyRecord.brain_folder;
      delete legacyRecord.slack_internal_channel_id;
      delete legacyRecord.slack_external_channel_id;
      delete legacyRecord.granola_title_match;
      delete legacyRecord.slack_extra_channel_ids;
      delete legacyRecord.granola_extra_title_matches;
      delete legacyRecord.airtable_base_id;
      delete legacyRecord.clay_dnc_webhook_url;
      patched = await fetch(`${url}/rest/v1/rr_workspaces?${patchFilter}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(legacyRecord) });
    }
    const patchText = await patched.text();
    let patchData: unknown = null; try { patchData = patchText ? JSON.parse(patchText) : null; } catch { patchData = patchText; }
    if (!patched.ok) return NextResponse.json({ ok: false, error: patchData || "Workspace update failed." }, { status: patched.status });
    const rows = Array.isArray(patchData) ? patchData : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "The workspace no longer exists. Refresh and try again." }, { status: 404 });
    await writeAuditEvent({ url, key }, { actor: "Admin console", action: "workspace.updated", entityType: "workspace", entityId: String(rows[0]?.id ?? id), details: { source: "admin", status: "success", workspaceId: rows[0]?.id ?? id, workspaceName: rows[0]?.name ?? payload.name, summary: `${rows[0]?.name ?? payload.name ?? "The client workspace"} configuration was saved successfully.` } });
    const workspaces = rows.map((row: Record<string, unknown>) => ({ ...row, key_configured: Boolean(row.heyreach_api_key_ciphertext), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined }));
    fileMessagingAfterSave(String(rows[0]?.slug ?? payload.slug ?? ""), existingGuardrails);
    return NextResponse.json({ ok: true, workspaces }, { status: 200 });
  }
  let response = await fetch(`${url}/rest/v1/rr_workspaces?on_conflict=slug`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(record) });
  if (!response.ok && (response.status === 400 || response.status === 422)) {
    const legacyRecord = { ...record };
    delete legacyRecord.timezone;
    delete legacyRecord.website_url;
    delete legacyRecord.brain_folder;
    delete legacyRecord.slack_internal_channel_id;
    delete legacyRecord.slack_external_channel_id;
    delete legacyRecord.granola_title_match;
    delete legacyRecord.slack_extra_channel_ids;
    delete legacyRecord.granola_extra_title_matches;
    delete legacyRecord.airtable_base_id;
    delete legacyRecord.clay_dnc_webhook_url;
    response = await fetch(`${url}/rest/v1/rr_workspaces?on_conflict=slug`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(legacyRecord) });
  }
  const body = await response.text();
  let data: unknown = null; try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  const workspaces = Array.isArray(data) ? data.map((row: Record<string, unknown>) => ({ ...row, key_configured: Boolean(row.heyreach_api_key_ciphertext), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined })) : data;
  if (response.ok && Array.isArray(data) && data[0]) await writeAuditEvent({ url, key }, { actor: "Admin console", action: "workspace.created", entityType: "workspace", entityId: String(data[0].id ?? ""), details: { source: "admin", status: "success", workspaceId: data[0].id, workspaceName: data[0].name ?? payload.name, summary: `${data[0].name ?? payload.name ?? "A client workspace"} was added to Reply Radar.` } });
  if (response.ok && Array.isArray(data) && data[0]) fileMessagingAfterSave(String(data[0].slug ?? payload.slug ?? ""), existingGuardrails);
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
  await writeAuditEvent({ url, key }, { actor: "Admin console", action: "workspace.deleted", entityType: "workspace", entityId: id || slug, details: { source: "admin", status: "success", workspaceName: slug || id, summary: `${slug || "The client workspace"} was removed from Reply Radar.` } });
  return NextResponse.json({ ok: true, deletedCount });
}
