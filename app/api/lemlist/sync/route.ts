// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { LEMLIST_WORKSPACE_COLUMNS, diagnoseLemlistShapes, syncLemlistReplies, type LemlistWorkspace } from "../../../lib/lemlist-ingest";
import { refreshLemlistStats } from "../../../lib/lemlist-figures";
import { alertNewReplies } from "../../../lib/reply-alert-run";
import { classifyLatestReply } from "../../../lib/reply-sentiment";

/**
 * The worker's lemlist pass (every five minutes, beside Email Bison's): for every client with a lemlist key,
 * replies since the last sync that the webhooks missed are pulled in, scored and posted to Slack.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  // `days` re-reads that far back (at most 30); the routine worker pass sends nothing and reads since the last sync.
  const body = (await request.json().catch(() => ({}))) as { days?: unknown; diagnose?: unknown; client?: unknown; stats?: unknown };
  const days = Math.min(30, Math.max(0, Number(body.days) || 0));
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const config = { url, key };
  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=${LEMLIST_WORKSPACE_COLUMNS}&lemlist_api_key=not.is.null&offboarded_at=is.null&order=lemlist_synced_at.asc.nullsfirst`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  // Before the migration is run the columns do not exist: nothing to do, not an error worth retrying.
  if (!response.ok) return NextResponse.json({ ok: true, skipped: `lemlist columns missing (${response.status}).` });
  const workspaces = (await response.json()) as LemlistWorkspace[];
  // Field names and lengths only (diagnoseLemlistShapes), never message text: safe on this machine path.
  if (body.diagnose === true) {
    const target = workspaces.find((row) => row.slug === String(body.client ?? ""));
    if (!target) return NextResponse.json({ ok: false, error: "That client has no lemlist key." }, { status: 404 });
    return NextResponse.json({ ok: true, shapes: await diagnoseLemlistShapes(target) });
  }
  // Which of them also have HeyReach: those keep HeyReach's client-wide daily row and its poll time.
  const keyed = await fetch(`${url}/rest/v1/rr_workspaces?select=id&heyreach_api_key_ciphertext=not.is.null`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const withHeyReach = new Set((Array.isArray(keyed) ? keyed : []).map((row: { id?: string }) => String(row.id ?? "")));
  const report: Array<Record<string, unknown>> = [];
  const started = Date.now();
  // `client` narrows the pass to one client (a queued "Sync now" for a lemlist client).
  const only = typeof body.client === "string" && body.client ? body.client : "";
  for (const workspace of only ? workspaces.filter((row) => row.slug === only) : workspaces) {
    if (Date.now() - started > 240_000) break;
    try {
      const sync = await syncLemlistReplies(config, workspace, days);
      // Campaign figures for briefs, QC Bot and analytics, hourly (the worker asks with `stats`).
      const stats = body.stats === true ? await refreshLemlistStats(config, workspace, withHeyReach.has(workspace.id)).catch((error) => ({ campaigns: 0, days: 0, error: error instanceof Error ? error.message.slice(0, 160) : "failed" })) : null;
      // For a lemlist-only client this is its outreach account answering, which is what the brief's
      // readiness check reads as "polled". A HeyReach client's poll time stays HeyReach's.
      if (!withHeyReach.has(workspace.id)) {
        await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ last_successful_poll_at: new Date().toISOString() }) }).catch(() => undefined);
      }
      if (stats) report.push({ client: workspace.slug, stats });
      for (const conversationId of sync.ingested) {
        await classifyLatestReply(config, conversationId, workspace.slug, { workspaceName: workspace.name }).catch(() => undefined);
        await alertNewReplies(config, conversationId).catch(() => undefined);
      }
      if (sync.checked || sync.ingested.length) report.push({ client: workspace.slug, checked: sync.checked, ingested: sync.ingested.length, skipped: Object.entries(sync.skipped).reduce<Record<string, number>>((out, [reason, count]) => { const key = reason.split(":")[0]; out[key] = (out[key] ?? 0) + count; return out; }, {}) });
    } catch (error) {
      report.push({ client: workspace.slug, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  }
  return NextResponse.json({ ok: true, clients: report });
}
