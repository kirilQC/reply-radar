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
import { brainBlobUrl, brainConfigured, brainFile, writeBrainFile } from "./brain";

type Row = Record<string, unknown>;

export type DncEntry = { id: string; company: string; domain: string | null; reason: string | null; addedBy: string | null; source: string; claySynced: boolean; createdAt: string };
export type DncResult = { company: string; domain: string | null; status: "added" | "updated" | "skipped"; clay: boolean };

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const orNull = (value: unknown) => (str(value).trim() ? str(value) : null);

// How long an add will wait for Clay to enrich a domain and push it back before answering anyway. The reply
// is worth a few seconds so it can name the domain; a slow Clay just returns without it (filled in later).
const DNC_CLAY_WAIT_MS = Math.max(0, Number(process.env.DNC_CLAY_WAIT_SECONDS || 40)) * 1000;
const DNC_POLL_MS = 3_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The client-id part of a stored brain_folder ("clients/emahealth" or "emahealth" → "emahealth"). */
function brainClientId(brainFolder: unknown): string {
  return str(brainFolder).trim().replace(/^clients\//i, "").replace(/\/+$/, "");
}

/** A clickable GitHub link to the client's DNC file in the brain, or null when there's no brain folder. */
function dncBrainLink(brainFolder: unknown): string | null {
  const clientId = brainClientId(brainFolder);
  // /blob/HEAD/ resolves to whatever the repo's default branch is, so the link is right regardless of its name.
  return clientId ? brainBlobUrl(`clients/${clientId}/account/dnc.md`, "HEAD") : null;
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
): Promise<{ ok: boolean; error?: string; client?: string; results?: DncResult[]; total?: number; link?: string | null; notConfigured?: boolean }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(clientRef);
  if (!client) return { ok: false, error: `No single client matches "${clientRef}".` };

  const names = [...new Set(companies.map((c) => str(c).trim()).filter(Boolean))];
  if (!names.length) return { ok: false, error: "No company names to add." };

  // The client's Clay DNC webhook + brain folder, and what's already on the list (to tell an add from an update).
  const workspaceRow = (await rows(url, key, `rr_workspaces?select=clay_dnc_webhook_url,brain_folder&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0];
  const clayWebhook = str(workspaceRow?.clay_dnc_webhook_url).trim();
  // Without the Clay integration, a DNC add cannot work end to end (no domain, no sync). Do not half-add it to
  // the mirror — return "not configured" so the caller tells the user to set Clay up first.
  if (!clayWebhook) return { ok: true, client: client.name, notConfigured: true };
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

  // Wait for Clay to enrich the domain(s) and push them back (via /api/webhooks/dnc), so the reply can name the
  // domain instead of "it'll fill in later". Bounded: once every added company has a domain we stop early, and
  // if Clay is slow we give up at the deadline and answer with whatever is there. Only worth waiting when Clay
  // was actually reached; without a webhook the domain would never arrive.
  const pendingKeys = clayWebhook ? results.filter((r) => r.status !== "skipped").map((r) => dncKey(r.company)) : [];
  if (pendingKeys.length && DNC_CLAY_WAIT_MS > 0) {
    const deadline = Date.now() + DNC_CLAY_WAIT_MS;
    for (;;) {
      const snap = await rows(url, key, `rr_dnc?select=key,domain&workspace_id=eq.${encodeURIComponent(client.id)}`);
      const byKey = new Map(snap.map((row) => [str(row.key), orNull(row.domain)]));
      if (pendingKeys.every((k) => byKey.get(k)) || Date.now() >= deadline) break;
      await sleep(DNC_POLL_MS);
    }
  }

  // Mirror the (now domain-enriched) list into the client's brain folder (best effort — never fails the add).
  if (results.some((r) => r.status !== "skipped")) await syncDncToBrain(client.id, client.name).catch(() => {});

  // Final read: the running total, and the domain each company now has (populated once Clay synced it back — we
  // never enrich it ourselves).
  const all = await rows(url, key, `rr_dnc?select=key,domain&workspace_id=eq.${encodeURIComponent(client.id)}`);
  const domainByKey = new Map(all.map((row) => [str(row.key), orNull(row.domain)]));
  for (const r of results) r.domain = domainByKey.get(dncKey(r.company)) ?? r.domain;

  return { ok: true, client: client.name, results, total: all.length, link: dncBrainLink(workspaceRow?.brain_folder) };
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
  const addedBy = flatPick(body, ["added_by", "addedby", "owner"]);

  /*
   * Only the fields Clay actually sent. A merge-duplicates upsert updates every column in the body, so
   * sending `reason: null` because Clay's table has no reason column wiped the reason (and the bot's
   * "added by") that the original add stored, every time Clay echoed the row back with its domain.
   */
  const rowBody: Row = { workspace_id: client.id, client: client.name, company: company || domain, key: dkey, source: "clay", clay_synced: true };
  if (domain) rowBody.domain = domain;
  if (reason) rowBody.reason = reason;
  if (addedBy) rowBody.added_by = addedBy;
  const response = await fetch(`${url}/rest/v1/rr_dnc?on_conflict=workspace_id,key`, {
    method: "POST",
    headers: { ...authHeaders(key, true), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(rowBody),
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

Companies QC must never reach out to for ${clientName}. Maintained automatically by QC Command; the working source of truth is this client's Clay DNC table. Do not edit by hand — changes here are overwritten on the next sync.

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
  await writeBrainFile({ path, text, summary: `Update ${clientName} DNC (${entries.length})`, author: "QC Command" }).catch(() => {});
}

/*
 * Clay pushes a table one row per request, so a 300-row resync is 300 webhook calls, and each used to
 * schedule its own brain sync: 300 reads of the whole list and as many GitHub reads racing each other.
 * Coalesce per client instead. The first call waits a moment for the burst to land, then syncs; any call
 * arriving while that is pending or running just marks the client dirty and shares the same promise, and a
 * dirty client gets exactly one more pass once the current one ends, so the last row is never left out.
 * Per instance only, which is fine: the file is only committed when it changed, so two instances that
 * both sync produce one commit, not two.
 */
const DNC_BRAIN_SETTLE_MS = 5_000;
const brainSyncs = new Map<string, { promise: Promise<void>; dirty: boolean }>();

export function scheduleDncBrainSync(workspaceId: string, clientName: string, settleMs = DNC_BRAIN_SETTLE_MS): Promise<void> {
  const running = brainSyncs.get(workspaceId);
  if (running) {
    running.dirty = true;
    return running.promise;
  }
  const state = { promise: Promise.resolve(), dirty: false };
  state.promise = (async () => {
    try {
      await sleep(settleMs);
      do {
        state.dirty = false;
        await syncDncToBrain(workspaceId, clientName).catch(() => {});
      } while (state.dirty);
    } finally {
      brainSyncs.delete(workspaceId);
    }
  })();
  brainSyncs.set(workspaceId, state);
  return state.promise;
}

/**
 * A value for a PostgREST filter, quoted so a comma, parenthesis or dot in a company name cannot break
 * out of an `or=(...)` list. Inside double quotes only `"` and `\` need escaping.
 */
export function pgQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An `ilike` pattern that matches the value exactly, case-insensitively: its own wildcards are escaped. */
function exactIlike(value: string): string {
  return value.replace(/\*/g, "").replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Everything on a client's DNC, newest first. */
export async function listDnc(clientRef: string): Promise<{ ok: boolean; error?: string; client?: string; entries?: DncEntry[]; total?: number; link?: string | null }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(clientRef);
  if (!client) return { ok: false, error: `No single client matches "${clientRef}".` };
  const wsRow = (await rows(url, key, `rr_workspaces?select=brain_folder&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0];
  const entries = (await rows(url, key, `rr_dnc?select=*&workspace_id=eq.${encodeURIComponent(client.id)}&order=created_at.desc`)).map(entryFromRow);
  return { ok: true, client: client.name, entries, total: entries.length, link: dncBrainLink(wsRow?.brain_folder) };
}

export type DncRemoveResult = {
  ok: boolean;
  error?: string;
  removed?: number;
  total?: number;
  link?: string | null;
  /** Rows that only partly match the term. Nothing is deleted when these are all there is. */
  candidates?: Array<{ company: string; domain: string | null }>;
};

/**
 * Take a company or domain back off a client's DNC (our mirror only — Clay is left to the client to prune).
 *
 * Exact matches only: the normalized company key, or the domain compared case-insensitively. This used
 * to delete every row whose name or domain merely contained the term, so "removing Acme" also took Acme
 * Health and acmecorp.io off the list, which for a do-not-contact list means contacting them. When the
 * term only partly matches, nothing is deleted and the near misses come back so the caller can ask which.
 */
export async function removeFromDnc(clientRef: string, companyOrDomain: string): Promise<DncRemoveResult> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(clientRef);
  if (!client) return { ok: false, error: `No single client matches "${clientRef}".` };
  const term = str(companyOrDomain).trim();
  if (!term) return { ok: false, error: "Name or domain to remove is required." };
  const workspace = `workspace_id=eq.${encodeURIComponent(client.id)}`;
  const nameKey = dncKey(term);
  const domain = cleanDomain(term);
  const exact = [
    nameKey ? `key.eq.${pgQuote(nameKey)}` : "",
    // A row Clay pushed with no company name is keyed on its domain.
    domain ? `key.eq.${pgQuote(domain)}` : "",
    domain ? `domain.ilike.${pgQuote(exactIlike(domain))}` : "",
  ].filter(Boolean);
  if (!exact.length) return { ok: false, error: "Name or domain to remove is required." };
  const filter = `${workspace}&or=${encodeURIComponent(`(${exact.join(",")})`)}`;
  const response = await fetch(`${url}/rest/v1/rr_dnc?${filter}`, { method: "DELETE", headers: { ...authHeaders(key), Prefer: "return=representation" } });
  if (!response.ok) return { ok: false, error: "Could not remove that entry." };
  const deleted = (await response.json().catch(() => [])) as Row[];
  const removed = Array.isArray(deleted) ? deleted.length : 0;
  // A removal changes the list, so refresh the brain file and re-count.
  if (removed) await syncDncToBrain(client.id, client.name).catch(() => {});
  const wsRow = (await rows(url, key, `rr_workspaces?select=brain_folder&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0];
  const all = await rows(url, key, `rr_dnc?select=company,domain&${workspace}`);
  if (removed) return { ok: true, removed, total: all.length, link: dncBrainLink(wsRow?.brain_folder) };

  // Nothing matched exactly: look for near misses in code rather than with a wildcard filter, so the term
  // never has to survive PostgREST's pattern syntax.
  const needle = term.toLowerCase();
  const candidates = all
    .map((row) => ({ company: str(row.company), domain: orNull(row.domain) }))
    .filter((row) => row.company.toLowerCase().includes(needle) || (row.domain ?? "").toLowerCase().includes(needle) || (nameKey && dncKey(row.company).includes(nameKey)))
    .slice(0, 20);
  if (candidates.length) {
    const list = candidates.map((c) => (c.domain ? `${c.company} (${c.domain})` : c.company)).join(", ");
    return {
      ok: false,
      removed: 0,
      total: all.length,
      link: dncBrainLink(wsRow?.brain_folder),
      candidates,
      error: `Nothing on the DNC is exactly "${term}", so nothing was removed. Close matches: ${list}. Ask which one to remove and call again with its exact name or domain.`,
    };
  }
  return { ok: true, removed: 0, total: all.length, link: dncBrainLink(wsRow?.brain_folder) };
}
