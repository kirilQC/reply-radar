// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { LEMLIST_WORKSPACE_COLUMNS, syncLemlistReplies, type LemlistWorkspace } from "../../../lib/lemlist-ingest";
import { alertNewReplies } from "../../../lib/reply-alert-run";
import { classifyLatestReply } from "../../../lib/reply-sentiment";

/**
 * The worker's lemlist pass (every five minutes, beside Email Bison's): for every client with a lemlist key,
 * replies since the last sync that the webhooks missed are pulled in, scored and posted to Slack.
 */
export const maxDuration = 300;

export async function POST() {
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
  const report: Array<Record<string, unknown>> = [];
  const started = Date.now();
  for (const workspace of workspaces) {
    if (Date.now() - started > 240_000) break;
    try {
      const sync = await syncLemlistReplies(config, workspace);
      for (const conversationId of sync.ingested) {
        await classifyLatestReply(config, conversationId, workspace.slug, { workspaceName: workspace.name }).catch(() => undefined);
        await alertNewReplies(config, conversationId).catch(() => undefined);
      }
      if (sync.checked || sync.ingested.length) report.push({ client: workspace.slug, checked: sync.checked, ingested: sync.ingested.length, skipped: sync.skipped });
    } catch (error) {
      report.push({ client: workspace.slug, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  }
  return NextResponse.json({ ok: true, clients: report });
}
