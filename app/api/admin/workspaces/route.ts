// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, after } from "next/server";
import { resolveModel } from "../../../../shared/anthropic-model.mjs";
import { isAiArkEnrichmentEnabled } from "../../../lib/lead-identity";
import { writeAuditEvent } from "../../../lib/audit-log";
import { isOurWebhookUrl, publicBaseUrl, webhookUrlFor, workspaceSlug } from "../../../lib/public-url";
import { LEGACY_SLUGS_KEY, withLegacySlug } from "../../../lib/legacy-slug";
import { firstChannelClash, type ChannelOwner } from "../../../lib/channel-clash";
import { normalizeChannelId } from "../../../lib/slack-channel";
import { syncMessagingDocForSlug } from "../../../lib/messaging-sync";
import { writeConfig } from "../../../lib/app-config";
import { briefMemoryResetKey } from "../../../lib/morning-brief-run";
import { slimImages, isImageRef } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


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

/**
 * True when a PostgREST error is about the `offboarded_at` column, i.e. the migration has not run yet.
 */
function missingOffboardedColumn(errorText: string): boolean {
  return /offboarded_at/i.test(errorText);
}

export async function GET(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return slimJson({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  // Offboarded (legacy) clients are left out unless Configuration asks for everyone with ?include=all.
  const includeAll = new URL(request.url).searchParams.get("include") === "all";
  /*
   * One list read with `offboarded_at` selected (and filtered on, for the default). A database without the
   * column answers with an error naming it; the read is then repeated without it and everyone is active,
   * so the sidebar and every page keep working while the migration waits to be run.
   */
  const list = async (columns: string) => {
    const filter = includeAll ? "" : "&offboarded_at=is.null";
    const response = await fetch(`${url}/rest/v1/rr_workspaces?select=${columns},offboarded_at&slug=neq.misc${filter}&order=name.asc`, { headers, cache: "no-store" });
    if (response.ok) return response;
    const errorText = await response.clone().text().catch(() => "");
    if (!missingOffboardedColumn(errorText)) return response;
    return fetch(`${url}/rest/v1/rr_workspaces?select=${columns}&slug=neq.misc&order=name.asc`, { headers, cache: "no-store" });
  };
  let response = await list("id,name,slug,client_brief,anthropic_model,custom_system_prompt,logo_url,accent_color,timezone,website_url,brain_folder,slack_internal_channel_id,slack_external_channel_id,slack_extra_channel_ids,granola_title_match,granola_extra_title_matches,airtable_base_id,clay_dnc_webhook_url,morning_brief_enabled,webhook_url,webhook_secret_hash,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext,guardrails");
  // Permit the UI to keep working while the additive migration is being run.
  if (!response.ok) response = await list("id,name,slug,client_brief,anthropic_model,logo_url,accent_color,webhook_url,webhook_secret_hash,last_webhook_received_at,last_successful_poll_at,created_at,heyreach_api_key_ciphertext,guardrails");
  const rows = await response.json();
  // Recomputed, not just read: a workspace configured before the domain moved holds the old address,
  // and the address is the one thing on this screen that somebody copies into another company's
  // dashboard. Anything already pointing at us is left exactly as it is.
  const base = publicBaseUrl(request);
  const workspaces = Array.isArray(rows) ? rows.map((row) => ({ ...row, webhook_url: isOurWebhookUrl(row.webhook_url, base) ? row.webhook_url : webhookUrlFor(row.slug, request), key_configured: Boolean(row.heyreach_api_key_ciphertext), ai_ark_enrichment_enabled: Boolean(row.guardrails?.ai_ark_enrichment_enabled), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", offboardedAt: row.offboarded_at ?? null, heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined })) : rows;
  return slimJson({ ok: response.ok, workspaces, aiArkConfigured: Boolean(process.env.AI_ARK_API_KEY), aiArkEnrichmentEnabled: isAiArkEnrichmentEnabled() }, { status: response.ok ? 200 : response.status });
}

/**
 * A PostgREST failure as one sentence for the form. The raw error object used to be returned as `error`,
 * and the page printed it as "[object Object]". A unique violation on the slug gets its own wording,
 * because it is the one failure here a person can fix by changing what they typed.
 */
function postgrestMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object") {
    const row = data as { code?: unknown; message?: unknown; details?: unknown };
    if (row.code === "23505" && /slug/i.test(`${row.message ?? ""} ${row.details ?? ""}`)) return "That slug is already used by another client. Pick another slug.";
    if (typeof row.message === "string" && row.message.trim()) return row.message;
  }
  if (typeof data === "string" && data.trim()) return data.trim().slice(0, 300);
  return fallback;
}

/** Columns an older database may not have yet. Dropped on a 400/422 and the write retried without them. */
const LEGACY_OPTIONAL_COLUMNS = ["timezone", "website_url", "brain_folder", "slack_internal_channel_id", "slack_external_channel_id", "granola_title_match", "slack_extra_channel_ids", "granola_extra_title_matches", "airtable_base_id", "clay_dnc_webhook_url"];
const withoutLegacyColumns = (record: Record<string, unknown>) => {
  const legacy = { ...record };
  for (const column of LEGACY_OPTIONAL_COLUMNS) delete legacy[column];
  return legacy;
};

const presentRow = (row: Record<string, unknown>) => ({ ...row, offboardedAt: row.offboarded_at ?? null, key_configured: Boolean(row.heyreach_api_key_ciphertext), heyreach_api_key_masked: row.heyreach_api_key_ciphertext ? `Saved key ••••${String(row.heyreach_api_key_ciphertext).slice(-4)}` : "", heyreach_api_key_ciphertext: undefined, webhook_secret_hash: undefined });

export async function POST(request: Request) {
  const { url, key } = supabaseConfig();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const payload = await request.json();
  const previousSlug = typeof payload.previousSlug === "string" ? payload.previousSlug.trim() : "";
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const create = payload.create === true;
  const patchFilter = create ? "" : id ? `id=eq.${encodeURIComponent(id)}` : previousSlug ? `slug=eq.${encodeURIComponent(previousSlug)}` : "";
  if (!create && !patchFilter) return NextResponse.json({ ok: false, error: "Which workspace to update is missing. Refresh and try again." }, { status: 400 });

  /*
   * Absent means "leave alone", not "clear", for every field.
   *
   * The logo upload used to send a partial payload, and this route rebuilt the whole row from it, so a
   * logo change wrote guardrails {} and custom_system_prompt null and wiped the client's ICP prompt,
   * follow-up prompt and reply prompt along with it. Only what the request names is written now; a create
   * is the one case with nothing to keep, so it fills in the defaults.
   */
  const has = (field: string) => Object.prototype.hasOwnProperty.call(payload, field);
  const record: Record<string, unknown> = {};
  if (has("name") || create) record.name = String(payload.name ?? "").trim();
  // Normalised here as well as in the form: this is the value that ends up in the webhook URL.
  const slug = workspaceSlug(has("slug") ? payload.slug : "") || (create ? workspaceSlug(payload.name) : "");
  if (create || has("slug")) {
    if (!slug) return NextResponse.json({ ok: false, error: "A workspace needs a name or a slug of letters and numbers." }, { status: 400 });
    record.slug = slug;
    record.webhook_url = webhookUrlFor(slug, request);
  }
  if (has("brainFolder")) record.brain_folder = payload.brainFolder || null;
  if (has("clientBrief")) record.client_brief = payload.clientBrief ?? null;
  if (has("anthropicModel")) record.anthropic_model = payload.anthropicModel ? resolveModel(String(payload.anthropicModel)) : null;
  if (has("systemPrompt")) record.custom_system_prompt = payload.systemPrompt || null;
  // A /api/img URL is what the GET handed out in place of the stored image; writing it back would replace
  // the logo with a pointer to itself.
  if (has("logoUrl") && !isImageRef(payload.logoUrl)) record.logo_url = payload.logoUrl || null;
  if (has("accentColor")) record.accent_color = payload.accentColor || null;
  if (has("timezone") || create) record.timezone = payload.timezone || "America/New_York";
  if (has("websiteUrl")) record.website_url = payload.websiteUrl || null;
  // Normalised on the way in rather than on the way out, because pasting the URL out of the address bar
  // is the common case.
  if (has("slackInternalChannelId")) record.slack_internal_channel_id = normalizeChannelId(payload.slackInternalChannelId) || null;
  if (has("slackExternalChannelId")) record.slack_external_channel_id = normalizeChannelId(payload.slackExternalChannelId) || null;
  const incomingGuardrails = payload.guardrails && typeof payload.guardrails === "object" && !Array.isArray(payload.guardrails) ? payload.guardrails as Record<string, unknown> : null;

  /*
   * One read of every other client, for the two checks that need them: the slug is not somebody else's,
   * and neither of this client's own channels is somebody else's.
   *
   * A create used to upsert on the slug, so adding "Acme" when an Acme already existed silently rewrote
   * the existing client with a blank form. On a create nothing is "self": a row with the same slug is
   * exactly the collision this is here to stop.
   */
  const ownChannels = [record.slack_internal_channel_id, record.slack_external_channel_id].filter((c): c is string => typeof c === "string" && Boolean(c));
  const slugChanging = Boolean(record.slug) && (create || record.slug !== previousSlug);
  let resetBriefMemoryFor = "";
  if (ownChannels.length || slugChanging || (!create && ("slackInternalChannelId" in payload || "slackExternalChannelId" in payload))) {
    const others = await fetch(`${url}/rest/v1/rr_workspaces?select=id,slug,name,slack_internal_channel_id,slack_external_channel_id`, { headers, cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const list: ChannelOwner[] = Array.isArray(others) ? others : [];
    const isSelf = (row: ChannelOwner) => !create && (id ? row.id === id : row.slug === previousSlug);
    if (slugChanging) {
      const taken = list.find((row) => row.slug === record.slug && !isSelf(row));
      if (taken) return NextResponse.json({ ok: false, error: `That slug is already used by ${String(taken.name || taken.slug)}. Pick another slug.` }, { status: 409 });
    }
    const self = list.find(isSelf);
    if (self?.id) {
      // The client's channels are changing: its past briefs were read from the old ones, so the next
      // brief must not take them as memory.
      const changed = ("slackInternalChannelId" in payload && (record.slack_internal_channel_id ?? null) !== (self.slack_internal_channel_id ?? null))
        || ("slackExternalChannelId" in payload && (record.slack_external_channel_id ?? null) !== (self.slack_external_channel_id ?? null));
      if (changed) resetBriefMemoryFor = String(self.id);
    }
    const clash = firstChannelClash(ownChannels, list.filter((row) => row.slug !== "misc"), isSelf);
    if (clash) return NextResponse.json({ ok: false, error: clash }, { status: 409 });
  }
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
  // Offboarding hides a client and pauses its automations; nothing is deleted, and false restores it.
  const offboardChange = !create && typeof payload.offboarded === "boolean";
  if (offboardChange) record.offboarded_at = payload.offboarded ? new Date().toISOString() : null;

  if (patchFilter) {
    /*
     * Guardrails are merged into what is stored, not replaced by what was sent.
     *
     * They hold settings owned by several screens at once (the ICP and follow-up prompts from AI context,
     * the messaging doc and internal-only switch from this form, enrichment flags from elsewhere), and the
     * form used to send back the whole object as it was when the page loaded, quietly reverting whatever
     * any other screen had saved since. Read-modify-write here means a save only ever moves the keys it
     * names.
     */
    // A slug change is read-modify-write too: the old slug is kept in guardrails.legacy_slugs so the
    // webhook URL HeyReach still holds keeps resolving (app/lib/legacy-slug.ts).
    if (incomingGuardrails || record.slug) {
      const current = await fetch(`${url}/rest/v1/rr_workspaces?select=slug,guardrails&${patchFilter}&limit=1`, { headers, cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!Array.isArray(current)) return NextResponse.json({ ok: false, error: "The workspace could not be read before saving. Try again." }, { status: 502 });
      if (!current.length) return NextResponse.json({ ok: false, error: "The workspace no longer exists. Refresh and try again." }, { status: 404 });
      const stored = current[0]?.guardrails && typeof current[0].guardrails === "object" && !Array.isArray(current[0].guardrails) ? current[0].guardrails as Record<string, unknown> : {};
      const currentSlug = String(current[0]?.slug ?? "");
      const renamed = Boolean(record.slug) && Boolean(currentSlug) && record.slug !== currentSlug;
      if (incomingGuardrails || renamed) {
        record.guardrails = {
          ...stored,
          ...(incomingGuardrails ?? {}),
          ...(renamed ? { [LEGACY_SLUGS_KEY]: withLegacySlug(stored[LEGACY_SLUGS_KEY], currentSlug, String(record.slug)) } : {}),
        };
      }
    }
    if (!Object.keys(record).length) return NextResponse.json({ ok: false, error: "Nothing to save." }, { status: 400 });
    const patch = (body: Record<string, unknown>) => fetch(`${url}/rest/v1/rr_workspaces?${patchFilter}`, { method: "PATCH", headers: { ...headers, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
    let patched = await patch(record);
    if (!patched.ok && (patched.status === 400 || patched.status === 422)) patched = await patch(withoutLegacyColumns(record));
    const patchText = await patched.text();
    let patchData: unknown = null; try { patchData = patchText ? JSON.parse(patchText) : null; } catch { patchData = patchText; }
    if (!patched.ok) return NextResponse.json({ ok: false, error: postgrestMessage(patchData, "Workspace update failed.") }, { status: patched.status });
    const rows = Array.isArray(patchData) ? patchData : [];
    if (!rows.length) return NextResponse.json({ ok: false, error: "The workspace no longer exists. Refresh and try again." }, { status: 404 });
    if (resetBriefMemoryFor) await writeConfig(briefMemoryResetKey(resetBriefMemoryFor), new Date().toISOString()).catch(() => {});
    if (offboardChange) {
      const name = String(rows[0]?.name ?? "The client workspace");
      await writeAuditEvent({ url, key }, { actor: "Admin console", action: payload.offboarded ? "workspace.offboarded" : "workspace.restored", entityType: "workspace", entityId: String(rows[0]?.id ?? id), details: { source: "admin", status: "success", workspaceId: rows[0]?.id ?? id, workspaceName: name, summary: payload.offboarded ? `${name} was offboarded. Its data is kept.` : `${name} was restored from legacy clients.` } });
    } else await writeAuditEvent({ url, key }, { actor: "Admin console", action: "workspace.updated", entityType: "workspace", entityId: String(rows[0]?.id ?? id), details: { source: "admin", status: "success", workspaceId: rows[0]?.id ?? id, workspaceName: rows[0]?.name ?? payload.name, summary: `${rows[0]?.name ?? payload.name ?? "The client workspace"} configuration was saved successfully.` } });
    const workspaces = rows.map((row: Record<string, unknown>) => presentRow(row));
    // Only when this save touched the guardrails: a logo upload has no business starting a Docs sync.
    if (incomingGuardrails) fileMessagingAfterSave(String(rows[0]?.slug ?? ""), record.guardrails as Record<string, unknown>);
    return slimJson({ ok: true, workspaces }, { status: 200 });
  }

  // A plain insert, never merge-duplicates: if a racing create took the slug between the check above and
  // here, the unique violation is reported instead of the existing client being overwritten.
  record.guardrails = incomingGuardrails ?? {};
  const insert = (body: Record<string, unknown>) => fetch(`${url}/rest/v1/rr_workspaces`, { method: "POST", headers: { ...headers, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify(body) });
  let response = await insert(record);
  if (!response.ok && (response.status === 400 || response.status === 422)) response = await insert(withoutLegacyColumns(record));
  const body = await response.text();
  let data: unknown = null; try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) return NextResponse.json({ ok: false, error: postgrestMessage(data, "The workspace could not be created.") }, { status: response.status });
  const created = Array.isArray(data) ? data : [];
  const workspaces = created.map((row: Record<string, unknown>) => presentRow(row));
  if (created[0]) {
    await writeAuditEvent({ url, key }, { actor: "Admin console", action: "workspace.created", entityType: "workspace", entityId: String(created[0].id ?? ""), details: { source: "admin", status: "success", workspaceId: created[0].id, workspaceName: created[0].name ?? payload.name, summary: `${created[0].name ?? payload.name ?? "A client workspace"} was added to QC Command.` } });
    fileMessagingAfterSave(String(created[0].slug ?? slug), record.guardrails as Record<string, unknown>);
  }
  return slimJson({ ok: true, workspaces }, { status: 201 });
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
  await writeAuditEvent({ url, key }, { actor: "Admin console", action: "workspace.deleted", entityType: "workspace", entityId: id || slug, details: { source: "admin", status: "success", workspaceName: slug || id, summary: `${slug || "The client workspace"} was removed from QC Command.` } });
  return NextResponse.json({ ok: true, deletedCount });
}
