// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Filing a client's Google Doc campaign messaging into their QC Brain folder.
 *
 * ── What this ties together ──────────────────────────────────────────────────────────────────────
 * The doc URL is already stored on the workspace (`guardrails.messaging_doc_url`, set from the admin
 * client-config tab). This reads it, fetches every tab through `google-docs.ts`, matches the client to its
 * brain folder with the same `brainFolderFor` rule the weekly-call filing and the QC Brain tab use, and
 * writes each net-new tab as `clients/<folder>/Campaign messaging/<tab>.md` through the automation write
 * rail. Which tabs have been filed is remembered back on the workspace in `guardrails.messaging_synced_tabs`
 * — the same jsonb, so there is no new table to keep in step.
 *
 * ── Why "new tabs only" is enforced here ─────────────────────────────────────────────────────────
 * The agency writes a tab once and rarely edits it, so the daily job files tabs it has not seen and leaves
 * the rest alone. `unsyncedTabs` does the set subtraction; this file is what persists the growing set, so
 * a tab filed today is not filed again tomorrow. A first sync — an empty set — files everything, which is
 * the "fetch all current tabs" the operator gets the moment they paste the URL.
 *
 * ── Why nothing here throws to its caller ────────────────────────────────────────────────────────
 * Like every brain-filing step, a missing folder, an unconnected Google, an unconnected brain or a Google
 * hiccup come back as a `note` on the result rather than as an exception. The cron files every client it
 * can and reports the ones it could not, instead of one bad doc ending the pass.
 */

import { brainConfigured, brainTree, writeBrainFile } from "./brain";
import { fetchMessagingTabs, googleDocsConfigured } from "./google-docs";
import { brainFolderFor } from "../../shared/brain-link.mjs";
import { clientsIn } from "../../shared/brain-structure.mjs";
import { messagingTabBrainDoc, unsyncedTabs } from "../../shared/google-doc.mjs";

type Guardrails = Record<string, unknown>;

type SyncWorkspace = {
  id: string;
  name: string;
  slug: string;
  brainFolder: string;
  docUrl: string;
  syncedTabs: string[];
  guardrails: Guardrails;
};

export type MessagingSyncResult = {
  workspace: string;
  filed: number;
  skipped: number;
  note: string;
};

function supabase() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

/**
 * The workspaces that carry a messaging doc, or a single one by slug.
 *
 * Only rows with a `messaging_doc_url` come back — a doc-less client is nothing for this job to do. Read
 * with the service role because the cron runs with no session, the same as every other background read.
 */
async function loadSyncWorkspaces(slug?: string): Promise<SyncWorkspace[]> {
  const { url, key } = supabase();
  if (!url || !key) return [];
  const filter = slug ? `&slug=eq.${encodeURIComponent(slug)}` : "";
  const response = await fetch(
    `${url}/rest/v1/rr_workspaces?select=id,name,slug,brain_folder,guardrails&order=name.asc${filter}`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
  ).catch(() => null);
  if (!response?.ok) return [];
  const rows = (await response.json().catch(() => [])) as Record<string, unknown>[];
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const guardrails = row.guardrails && typeof row.guardrails === "object" ? (row.guardrails as Guardrails) : {};
      const synced = Array.isArray(guardrails.messaging_synced_tabs)
        ? (guardrails.messaging_synced_tabs as unknown[]).map(String)
        : [];
      return {
        id: String(row.id ?? ""),
        name: String(row.name ?? ""),
        slug: String(row.slug ?? ""),
        brainFolder: String(row.brain_folder ?? ""),
        docUrl: String(guardrails.messaging_doc_url ?? "").trim(),
        syncedTabs: synced,
        guardrails,
      };
    })
    .filter((workspace) => workspace.docUrl);
}

/**
 * Remember the tabs now filed, merged into the workspace's existing guardrails.
 *
 * The whole guardrails object is written back, not just the one key, because a PATCH of a jsonb column
 * replaces it — writing `{ messaging_synced_tabs }` alone would wipe the doc URL and everything else. The
 * ids are de-duplicated so a re-run cannot grow the list without bound.
 */
async function rememberSyncedTabs(workspace: SyncWorkspace, tabIds: string[]): Promise<void> {
  const { url, key } = supabase();
  if (!url || !key) return;
  const next = { ...workspace.guardrails, messaging_synced_tabs: [...new Set(tabIds.map(String))] };
  await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, {
    method: "PATCH",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ guardrails: next }),
  }).catch(() => null);
}

/**
 * File one workspace's net-new messaging tabs into its brain folder.
 *
 * The order of the guards is the order of the excuses: no doc, no Google, no brain, no matching folder —
 * each a note rather than a throw. When there is work, only the unsynced tabs are written, and the synced
 * set is grown only after the writes so a crash mid-pass re-files rather than skips.
 */
export async function syncMessagingDoc(workspace: SyncWorkspace): Promise<MessagingSyncResult> {
  const base: MessagingSyncResult = { workspace: workspace.slug, filed: 0, skipped: 0, note: "" };
  if (!workspace.docUrl) return { ...base, note: "No messaging document is set for this client." };
  if (!googleDocsConfigured()) return { ...base, note: "Google is not connected. Set GOOGLE_SERVICE_ACCOUNT_KEY." };
  if (!brainConfigured()) return { ...base, note: "The QC Brain is not connected." };

  const paths = (await brainTree()).map((file) => file.path);
  const { folder } = brainFolderFor(
    { slug: workspace.slug, name: workspace.name, brainFolder: workspace.brainFolder },
    clientsIn(paths),
  ) as { folder: string };
  if (!folder) return { ...base, note: `No QC Brain folder matches ${workspace.name || "this client"}.` };

  const tabs = await fetchMessagingTabs(workspace.docUrl);
  const pending = unsyncedTabs(tabs, workspace.syncedTabs);

  const filedIds: string[] = [];
  for (const tab of pending) {
    const { path, text } = messagingTabBrainDoc(folder, tab);
    await writeBrainFile({ path, text, summary: `Campaign messaging: ${workspace.name} — ${tab.title}`, author: "Reply Radar" });
    filedIds.push(tab.tabId);
  }

  if (filedIds.length) await rememberSyncedTabs(workspace, [...workspace.syncedTabs, ...filedIds]);
  return { ...base, filed: filedIds.length, skipped: tabs.length - pending.length };
}

/**
 * One workspace by slug — the on-paste first sync the admin save fires.
 *
 * Returns a note rather than throwing when the slug has no doc, so the caller can log a line and the save
 * itself is never turned into a failure by a messaging sync that had nothing to do.
 */
export async function syncMessagingDocForSlug(slug: string): Promise<MessagingSyncResult> {
  const [workspace] = await loadSyncWorkspaces(slug);
  if (!workspace) return { workspace: slug, filed: 0, skipped: 0, note: "No messaging document is set for this client." };
  return syncMessagingDoc(workspace);
}

/**
 * Every workspace with a messaging doc — the daily cron.
 *
 * Serial, not parallel: each client is a Docs read plus a handful of GitHub writes against the same token
 * bucket the MCP chat shares, so a burst would make a live answer crawl and could trip a rate limit that
 * turns the whole pass into error rows. A deadline comfortably inside the function ceiling stops it taking
 * on a new client it cannot finish; the ones it skipped are simply picked up next run.
 */
export async function syncAllMessagingDocs(opts: { deadlineMs?: number } = {}): Promise<MessagingSyncResult[]> {
  const started = Date.now();
  const deadline = typeof opts.deadlineMs === "number" && opts.deadlineMs > 0 ? opts.deadlineMs : 50_000;
  const workspaces = await loadSyncWorkspaces();
  const results: MessagingSyncResult[] = [];
  for (const workspace of workspaces) {
    if (Date.now() - started > deadline) {
      results.push({ workspace: workspace.slug, filed: 0, skipped: 0, note: "Deadline reached; will resume next run." });
      continue;
    }
    try {
      results.push(await syncMessagingDoc(workspace));
    } catch (error) {
      results.push({ workspace: workspace.slug, filed: 0, skipped: 0, note: error instanceof Error ? error.message : "Sync failed." });
    }
  }
  return results;
}
