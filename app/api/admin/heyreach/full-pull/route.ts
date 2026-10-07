// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The "Full HeyReach pull" button on a client's Configuration page.
 *
 * POST queues the pull for the worker (worker/render-worker.mjs `fullPull`), which clears and rebuilds
 * the client's stored HeyReach figures, removes conversations not in this HeyReach account and pulls in
 * every conversation QC does not hold. It runs for minutes, so it cannot run inside this request. The key
 * is checked against HeyReach first, so a wrong key fails here instead of after the stats were cleared.
 *
 * GET reports the latest pull for the client, plus the real last reconciliation and last webhook times
 * that the page used to show as fixed placeholder text.
 */

import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../../lib/audit-log";

type Row = Record<string, unknown>;

function config() {
  return { url: process.env.SUPABASE_URL ?? "", key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" };
}

async function rest(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
}

async function readRows(path: string): Promise<Row[]> {
  const response = await rest(path);
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

async function workspaceFor(slug: string): Promise<Row | null> {
  const rows = await readRows(`rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext,last_reconciled_at,last_webhook_received_at&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  return rows[0] ?? null;
}

async function latestPull(workspaceId: string): Promise<Row | null> {
  const rows = await readRows(`rr_sync_runs?select=id,status,source,started_at,finished_at,records_seen,records_written,error_text&workspace_id=eq.${encodeURIComponent(workspaceId)}&run_type=eq.full_pull&order=started_at.desc&limit=1`);
  return rows[0] ?? null;
}

const present = (workspace: Row, pull: Row | null) => ({
  ok: true,
  lastReconciledAt: workspace.last_reconciled_at ?? null,
  lastWebhookAt: workspace.last_webhook_received_at ?? null,
  pull: pull
    ? {
        status: String(pull.status ?? ""),
        continuing: pull.source === "admin-continue",
        startedAt: pull.started_at ?? null,
        finishedAt: pull.finished_at ?? null,
        conversationsInHeyReach: Number(pull.records_seen ?? 0),
        pulledIn: Number(pull.records_written ?? 0),
        summary: String(pull.error_text ?? ""),
      }
    : null,
});

export async function GET(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const slug = (new URL(request.url).searchParams.get("client") ?? "").trim();
  if (!slug) return NextResponse.json({ ok: false, error: "client required" }, { status: 400 });
  try {
    const workspace = await workspaceFor(slug);
    if (!workspace) return NextResponse.json({ ok: false, error: "No such client." }, { status: 404 });
    return NextResponse.json(present(workspace, await latestPull(String(workspace.id))));
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the pull status." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Row;
  const slug = typeof body.client === "string" ? body.client.trim() : "";
  if (!slug) return NextResponse.json({ ok: false, error: "client required" }, { status: 400 });
  try {
    const workspace = await workspaceFor(slug);
    if (!workspace) return NextResponse.json({ ok: false, error: "No such client." }, { status: 404 });
    const apiKey = String(workspace.heyreach_api_key_ciphertext ?? "").trim();
    if (!apiKey) return NextResponse.json({ ok: false, error: "Save a HeyReach API key for this client first." }, { status: 400 });

    // The key is checked before anything is queued: a pull with a rejected key would clear the stats and
    // then fail, leaving the client with nothing.
    const base = (process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public/").replace(/\/$/, "");
    const check = await fetch(`${base}/auth/CheckApiKey`, { headers: { "X-API-KEY": apiKey }, cache: "no-store", signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!check) return NextResponse.json({ ok: false, error: "HeyReach could not be reached. Try again in a minute." }, { status: 502 });
    if (!check.ok) return NextResponse.json({ ok: false, error: "HeyReach rejected this client's API key. Save the right key, then pull again." }, { status: 400 });

    const current = await latestPull(String(workspace.id));
    if (current && (current.status === "queued" || current.status === "running")) {
      return NextResponse.json(present(workspace, current), { status: 409 });
    }
    const created = await rest("rr_sync_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ workspace_id: workspace.id, run_type: "full_pull", source: "admin", status: "queued", started_at: new Date().toISOString(), records_seen: 0, records_written: 0 }),
    });
    if (!created.ok) throw new Error(`Supabase ${created.status}: ${(await created.text()).slice(0, 200)}`);
    await writeAuditEvent({ url, key }, {
      actor: "Admin console",
      action: "heyreach.full_pull_requested",
      entityType: "workspace",
      entityId: String(workspace.id),
      details: { source: "admin", status: "success", workspaceId: workspace.id, workspaceName: workspace.name, summary: `A full HeyReach pull was requested for ${String(workspace.name ?? slug)}.` },
    }).catch(() => {});
    return NextResponse.json(present(workspace, await latestPull(String(workspace.id))));
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not queue the pull." }, { status: 502 });
  }
}
