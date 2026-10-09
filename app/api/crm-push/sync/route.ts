// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { rows, type Destination } from "../../../lib/crm-push";
import { pushPass } from "../../../lib/crm-push-run";
import { pushMeetingsPass } from "../../../lib/meetings-deals-run";
import { sheetsPushMeetings } from "../../../lib/sheets-push";

/**
 * The worker's automatic push (every few minutes): for every client whose CRM build is applied and whose
 * "Keep pushing new replies" is on, the conversations that moved since the last push go to their CRM.
 */
export const maxDuration = 300;

export async function POST() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const config = { url, key };
  const destinations = (await rows(config, "rr_crm_push?select=*&auto_push=is.true&status=eq.built&api_key=not.is.null").catch(() => [])) as unknown as Destination[];
  const report: Array<Record<string, unknown>> = [];
  const started = Date.now();
  for (const destination of destinations) {
    if (Date.now() - started > 230_000) break;
    // Fifteen minutes of overlap: a message stored late is still caught, and unchanged ones are skipped by hash.
    const last = Date.parse(destination.last_push_at ?? "");
    const since = new Date((Number.isNaN(last) ? Date.now() - 86_400_000 : last) - 15 * 60_000).toISOString();
    try {
      const summary = await pushPass(config, destination, { since, budgetMs: 60_000 });
      const deals = destination.provider === "google_sheets"
        ? ((destination.config as { content?: string } | null)?.content === "meetings" ? await sheetsPushMeetings(config, destination, { since }).then((done) => ({ pushed: done.pushed, failed: 0 })).catch(() => ({ pushed: 0, failed: 1 })) : null)
        : await pushMeetingsPass(config, destination, { since, budgetMs: 30_000 }).catch(() => null);
      if (summary.pushed || summary.failed || deals?.pushed || deals?.failed) report.push({ workspace: destination.workspace_id, pushed: summary.pushed, failed: summary.failed, deals: deals?.pushed ?? 0, dealsFailed: deals?.failed ?? 0 });
    } catch (error) {
      report.push({ workspace: destination.workspace_id, error: error instanceof Error ? error.message.slice(0, 160) : "failed" });
    }
  }
  return NextResponse.json({ ok: true, destinations: destinations.length, report });
}
