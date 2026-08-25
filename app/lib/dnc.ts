// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The do-not-contact (DNC) list: companies a client never wants us to reach out to.
 *
 * Two sources of truth, on purpose. The client-facing one is a table in the client's own Clay workspace,
 * which we write to through that table's webhook source (no Clay API key, and it works whether or not Clay
 * Audiences is on). Ours is `rr_dnc` in Supabase, which the bot reads back instantly — because Clay cannot be
 * queried reliably from here, the mirror is what answers "is acme.com on the DNC?" and "what's on the list?".
 *
 * We do NOT resolve a domain here — the domain enrichment lives in Clay, where it is done reliably against the
 * client's own logic. The bot just sends the company name; Clay fills the rest. Dedupe (ours and Clay's) is on
 * a normalized company name.
 */

import { resolveWorkspace } from "./meetings";
import { companyKey } from "./company-domain";
import { brainConfigured, brainFile, writeBrainFile } from "./brain";

type Row = Record<string, unknown>;

export type DncEntry = { id: string; company: string; domain: string | null; reason: string | null; addedBy: string | null; source: string; claySynced: boolean; createdAt: string };
export type DncResult = { company: string; domain: string | null; status: "added" | "updated" | "skipped"; clay: boolean };

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const orNull = (value: unknown) => (str(value).trim() ? str(value) : null);

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function authHeaders(key: string, write = false) {
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (write) headers.Prefer = "return=representation";
  return headers;
}
async function rows(url: string, key: string, path: string): Promise<Row[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: authHeaders(key), cache: "no-store" });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? (body as Row[]) : [];
}

/** The dedupe key for a DNC row: a normalized company name (Clay handles domains on its side). */
function dncKey(company: string): string {
  return companyKey(company);
}

function entryFromRow(row: Row): DncEntry {
  return {
    id: str(row.id),
    company: str(row.company),
    domain: orNull(row.domain),
    reason: orNull(row.reason),
    addedBy: orNull(row.added_by),
    source: str(row.source) || "manual",
    claySynced: Boolean(row.clay_synced),
    createdAt: str(row.created_at),
  };
}

/** Push one DNC row into the client's Clay table via its webhook source. Best effort; returns whether it landed. */
async function pushToClay(webhookUrl: string, payload: Row): Promise<boolean> {
  if (!webhookUrl) return false;
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Add one or more companies to a client's DNC.
 *
 * Upserts each into `rr_dnc` (dedupe on workspace + normalized-name key, so re-adding just refreshes the reason),
 * then pushes the company name to the client's Clay table if a webhook is configured — Clay resolves the domain
 * and anything else on its side. Returns a per-company breakdown so the bot can report exactly what it did.
 */
export async function addToDnc(
  clientRef: string,
  companies: string[],
  opts: { reason?: string; addedBy?: string; source?: string } = {},
): Promise<{ ok: boolean; error?: string; client?: string; results?: DncResult[] }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(clientRef);
  if (!client) return { ok: false, error: `No single client matches "${clientRef}".` };

  const names = [...new Set(companies.map((c) => str(c).trim()).filter(Boolean))];
  if (!names.length) return { ok: false, error: "No company names to add." };

  // The client's Clay DNC webhook, and what's already on the list (to tell an add from an update).
  const workspaceRow = (await rows(url, key, `rr_workspaces?select=clay_dnc_webhook_url&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0];
  const clayWebhook = str(workspaceRow?.clay_dnc_webhook_url).trim();
  const existing = new Set((await rows(url, key, `rr_dnc?select=key&workspace_id=eq.${encodeURIComponent(client.id)}`)).map((row) => str(row.key)));

  const results: DncResult[] = [];
  for (const company of names) {
    const dkey = dncKey(company);
    if (!dkey) { results.push({ company, domain: null, status: "skipped", clay: false }); continue; }
    const wasThere = existing.has(dkey);

    const rowBody = {
      workspace_id: client.id,
      client: client.name,
      company,
      domain: null,
      key: dkey,
      reason: opts.reason ? str(opts.reason) : null,
      added_by: opts.addedBy ? str(opts.addedBy) : null,
      source: opts.source ? str(opts.source) : "manual",
    };
    // Upsert on (workspace_id, key): a repeat add refreshes the reason rather than erroring.
    const response = await fetch(`${url}/rest/v1/rr_dnc?on_conflict=workspace_id,key`, {
      method: "POST",
      headers: { ...authHeaders(key, true), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(rowBody),
    });
    if (!response.ok) { results.push({ company, domain: null, status: "skipped", clay: false }); continue; }

    // Send just the company name to Clay — Clay does the domain enrichment on its side.
    const clay = clayWebhook
      ? await pushToClay(clayWebhook, { company, reason: rowBody.reason, client: client.name, added_by: rowBody.added_by, source: rowBody.source, added_at: new Date().toISOString() })
      : false;
    if (clay) {
      await fetch(`${url}/rest/v1/rr_dnc?workspace_id=eq.${encodeURIComponent(client.id)}&key=eq.${encodeURIComponent(dkey)}`, {
        method: "PATCH", headers: authHeaders(key), body: JSON.stringify({ clay_synced: true }),
      }).catch(() => {});
    }
    results.push({ company, domain: null, status: wasThere ? "updated" : "added", clay });
  }

  // Mirror the updated list into the client's brain folder (best effort — never fails the add).
  if (results.some((r) => r.status !== "skipped")) await syncDncToBrain(client.id, client.name).catch(() => {});

  return { ok: true, client: client.name, results };
}

/** Pick the first non-empty value among aliases from a loose payload, matched case/separator-insensitively. */
function flatPick(body: Row, aliases: string[]): string {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(body)) {
    if (v == null || typeof v === "object") continue;
    const nk = k.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const s = String(v).trim();
    if (s && !map.has(nk)) map.set(nk, s);
  }
  for (const alias of aliases) {
    const v = map.get(alias.replace(/[^a-z0-9]/gi, "").toLowerCase());
    if (v) return v;
  }
  return "";
}

const cleanDomain = (value: string) =>
  value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");

/**
 * Ingest one DNC row that Clay pushed to us (Clay's "HTTP API" action, one POST per row).
 *
 * This is the read-back path: since Clay exposes no API we can pull from, Clay instead pushes each row here, so
 * our mirror reflects the real Clay table — the domains Clay enriched, and companies added directly in Clay.
 * Routed by a `client` field in the payload (like the meetings webhook). Keyed on the normalized company name,
 * so a company the bot added by name and the same row Clay pushes back (now with a domain) collapse to one row
 * that simply gains its domain. Company/domain field names are matched flexibly, since Clay column names vary.
 */
export async function ingestDncFromClay(payload: unknown): Promise<{ ok: boolean; error?: string; client?: string; company?: string; workspaceId?: string; brainFolder?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const body = payload && typeof payload === "object" ? (payload as Row) : {};
  const clientName = flatPick(body, ["client", "client_name", "workspace", "account_slug"]);
  if (!clientName) return { ok: false, error: "The payload has no client field to route on. Add a static 'client' field naming the client." };
  const client = await resolveWorkspace(clientName);
  if (!client) return { ok: false, error: `No single client matches "${clientName}".` };

  const company = flatPick(body, ["company", "company_name", "name", "account", "organization"]);
  const domain = cleanDomain(flatPick(body, ["domain", "company_domain", "website", "url"]));
  if (!company && !domain) return { ok: false, error: "The payload had no company name or domain." };

  const dkey = company ? dncKey(company) : domain;
  if (!dkey) return { ok: false, error: "Nothing to key the row on." };
  const reason = flatPick(body, ["reason", "note", "notes"]);

  const response = await fetch(`${url}/rest/v1/rr_dnc?on_conflict=workspace_id,key`, {
    method: "POST",
    headers: { ...authHeaders(key, true), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      workspace_id: client.id,
      client: client.name,
      company: company || domain,
      domain: domain || null,
      key: dkey,
      reason: reason || null,
      source: "clay",
      clay_synced: true,
    }),
  });
  if (!response.ok) return { ok: false, error: "Could not store the row." };
  // Report back whether this client has a brain folder — the gate on the DNC→brain write — so a missing one
  // is visible in Clay's response rather than a silent no-op.
  const wsRow = (await rows(url, key, `rr_workspaces?select=brain_folder&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0];
  return { ok: true, client: client.name, company: company || domain, workspaceId: client.id, brainFolder: str(wsRow?.brain_folder).trim() };
}

/** The DNC file as it should read in the brain: a simple company + domain table, generated from the mirror. */
function renderDncMarkdown(clientName: string, entries: { company: string; domain: string | null }[]): string {
  const rows = entries
    .map((e) => `| ${e.company.replace(/\|/g, "\\|")} | ${(e.domain || "").replace(/\|/g, "\\|")} |`)
    .join("\n");
  return `# ${clientName} — Do Not Contact

Companies QC must never reach out to for ${clientName}. Maintained automatically by Reply Radar; the working source of truth is this client's Clay DNC table. Do not edit by hand — changes here are overwritten on the next sync.

| Company | Domain |
| --- | --- |
${rows || "| _(none yet)_ | |"}

${entries.length} ${entries.length === 1 ? "company" : "companies"}.
`;
}

/**
 * Mirror a client's DNC into their QC Brain — the `account/dnc.md` file the brain's "Do not contact" card
 * reads (see CLIENT_DOCS in shared/brain-structure.mjs). Client docs live at `clients/<id>/…`, so the full
 * path is `clients/<id>/account/dnc.md`.
 *
 * The brain is where a human (or their Claude Code) reads what QC intends for a client, so the DNC belongs
 * there too. Best effort: it needs the brain configured and the client to have a `brain_folder`. The file is
 * regenerated from the mirror and only committed when it actually changed, so re-pushing an existing row from
 * Clay does not create an empty commit.
 */
export async function syncDncToBrain(workspaceId: string, clientName: string): Promise<void> {
  if (!brainConfigured() || !workspaceId) return;
  const { url, key } = config();
  if (!url || !key) return;
  const wsRow = (await rows(url, key, `rr_workspaces?select=brain_folder&id=eq.${encodeURIComponent(workspaceId)}&limit=1`))[0];
  // brain_folder holds the client id (e.g. "emahealth"); tolerate a stored "clients/emahealth" too.
  const clientId = str(wsRow?.brain_folder).trim().replace(/^clients\//i, "").replace(/\/+$/, "");
  if (!clientId) return; // no brain folder configured for this client
  const entries = (await rows(url, key, `rr_dnc?select=company,domain&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=company.asc`))
    .map((row) => ({ company: str(row.company), domain: orNull(row.domain) }));
  const path = `clients/${clientId}/account/dnc.md`;
  const text = renderDncMarkdown(clientName, entries);
  try {
    const existing = await brainFile(path);
    if (existing.text.trim() === text.trim()) return; // nothing changed — skip the commit
  } catch { /* file doesn't exist yet — create it */ }
  await writeBrainFile({ path, text, summary: `Update ${clientName} DNC (${entries.length})`, author: "Reply Radar" }).catch(() => {});
}

/** Everything on a client's DNC, newest first. */
export async function listDnc(clientRef: string): Promise<{ ok: boolean; error?: string; client?: string; entries?: DncEntry[] }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(clientRef);
  if (!client) return { ok: false, error: `No single client matches "${clientRef}".` };
  const entries = (await rows(url, key, `rr_dnc?select=*&workspace_id=eq.${encodeURIComponent(client.id)}&order=created_at.desc`)).map(entryFromRow);
  return { ok: true, client: client.name, entries };
}

/** Take a company or domain back off a client's DNC (our mirror only — Clay is left to the client to prune). */
export async function removeFromDnc(clientRef: string, companyOrDomain: string): Promise<{ ok: boolean; error?: string; removed?: number }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(clientRef);
  if (!client) return { ok: false, error: `No single client matches "${clientRef}".` };
  const term = str(companyOrDomain).trim();
  if (!term) return { ok: false, error: "Name or domain to remove is required." };
  // Match on the normalized-name key, or a loose company/domain contains, so a name or a domain both work.
  const key1 = dncKey(term);
  const filter = `workspace_id=eq.${encodeURIComponent(client.id)}&or=(key.eq.${encodeURIComponent(key1)},company.ilike.*${encodeURIComponent(term)}*,domain.ilike.*${encodeURIComponent(term)}*)`;
  const response = await fetch(`${url}/rest/v1/rr_dnc?${filter}`, { method: "DELETE", headers: { ...authHeaders(key), Prefer: "return=representation" } });
  if (!response.ok) return { ok: false, error: "Could not remove that entry." };
  const deleted = (await response.json().catch(() => [])) as Row[];
  return { ok: true, removed: Array.isArray(deleted) ? deleted.length : 0 };
}
