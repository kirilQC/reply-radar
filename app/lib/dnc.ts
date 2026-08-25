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

  return { ok: true, client: client.name, results };
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
