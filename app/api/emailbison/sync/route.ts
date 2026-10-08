// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { bisonConfigured } from "../../../lib/emailbison";
import { EMAIL_WORKSPACE_COLUMNS, refreshBisonStats, syncBisonReplies, type EmailWorkspace } from "../../../lib/email-ingest";
import { alertNewReplies } from "../../../lib/reply-alert-run";
import { classifyLatestReply } from "../../../lib/reply-sentiment";

/**
 * The worker's email pass (every few minutes): for each active client linked to an Email Bison workspace,
 * the newest tracked replies not yet stored, each then handled like a webhook reply. `{ stats: true }` also
 * refreshes the email campaign and daily numbers (the worker asks for that hourly).
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  if (!bisonConfigured()) return NextResponse.json({ ok: true, skipped: "EMAILBISON_API_KEY / EMAILBISON_BASE_URL are not set." });
  const body = (await request.json().catch(() => ({}))) as Row;
  const config = { url, key };
  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=${EMAIL_WORKSPACE_COLUMNS}&slug=neq.misc&offboarded_at=is.null&order=emailbison_synced_at.asc.nullsfirst`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) return NextResponse.json({ ok: false, error: `Run the email channel migration (20261009_email_channel.sql). Supabase answered ${response.status}.` }, { status: 500 });
  const workspaces = (await response.json()) as EmailWorkspace[];
  // Clients whose only outreach account is Email Bison: this pass is their "polled", which the brief and
  // end-of-week readiness checks read. HeyReach and lemlist clients keep their own poll time.
  const others = await fetch(`${url}/rest/v1/rr_workspaces?select=id&or=(heyreach_api_key_ciphertext.not.is.null,lemlist_api_key.not.is.null)`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const hasOther = new Set((Array.isArray(others) ? others : []).map((row: Row) => String(row.id ?? "")));
  const report: Row[] = [];
  const started = Date.now();
  for (const workspace of workspaces) {
    if (Date.now() - started > 240_000) break;
    try {
      const sync = await syncBisonReplies(config, workspace);
      if (workspace.emailbison_workspace_id && !hasOther.has(workspace.id)) {
        await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ last_successful_poll_at: new Date().toISOString() }) }).catch(() => undefined);
      }
      for (const conversationId of sync.ingested) {
        await classifyLatestReply(config, conversationId, workspace.slug, { workspaceName: workspace.name }).catch(() => undefined);
        await alertNewReplies(config, conversationId).catch(() => undefined);
      }
      const stats = body.stats === true ? await refreshBisonStats(config, workspace) : null;
      if (sync.checked || sync.ingested.length || stats) report.push({ client: workspace.slug, checked: sync.checked, ingested: sync.ingested.length, ...(stats ?? {}) });
    } catch (error) {
      report.push({ client: workspace.slug, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  }
  return NextResponse.json({ ok: true, clients: report });
}
