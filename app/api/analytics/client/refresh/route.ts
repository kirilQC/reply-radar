// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";

/**
 * Asks the worker to collect one client's analytics now, rather than at its next daily turn.
 *
 * This route collects nothing itself. A pass is a couple of hundred HeyReach calls against a rate
 * limit the Render worker already owns and paces, and a serverless function has ten seconds — so the
 * request is written into `rr_sync_runs` as a `queued` analytics run and the worker claims it on its
 * next cycle, ahead of the rotation. The table is the channel because there is no other one: the
 * worker calls the app, never the reverse.
 *
 * What the page gets back is the queued row's own state, which it then watches through
 * `/api/analytics/client` as the worker moves it queued → running → success. That is why the progress
 * bar is not a timer: every step it shows is a row somebody wrote.
 */

type Row = Record<string, unknown>;

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

async function rest(path: string, init?: RequestInit): Promise<Row[]> {
  const { url, key } = config();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key as string, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  const body = await response.text();
  if (!body.trim()) return [];
  return JSON.parse(body) as Row[];
}

export async function POST(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, status: "not_configured" }, { status: 503 });
  const slug = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, status: "no_client" }, { status: 400 });

  try {
    const workspaces = await rest(`rr_workspaces?select=id,heyreach_api_key_ciphertext&slug=eq.${encodeURIComponent(slug)}&limit=1`);
    const workspace = workspaces[0];
    if (!workspace) return NextResponse.json({ ok: false, status: "not_found" }, { status: 404 });
    if (!workspace.heyreach_api_key_ciphertext) {
      return NextResponse.json({ ok: false, status: "no_key", message: "This client has no HeyReach key connected." }, { status: 409 });
    }
    const workspaceId = encodeURIComponent(String(workspace.id));

    /*
     * One request in flight at a time. Pressing the button twice, or two people opening the page and
     * both pressing it, would otherwise queue passes the worker works one per cycle — half an hour of
     * redundant HeyReach traffic for figures that were already being collected. The second press
     * reports the first request rather than failing, so the page shows a progress bar either way.
     */
    const inFlight = await rest(
      `rr_sync_runs?select=id,status,started_at&workspace_id=eq.${workspaceId}&run_type=eq.analytics&status=in.(queued,running)&order=started_at.asc&limit=1`,
    );
    if (inFlight[0]) {
      return NextResponse.json({ ok: true, status: "already_queued", state: String(inFlight[0].status ?? "queued"), requestedAt: String(inFlight[0].started_at ?? "") });
    }

    const queuedAt = new Date().toISOString();
    await rest("rr_sync_runs", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        workspace_id: workspace.id,
        run_type: "analytics",
        // Distinct from the worker's own `render-worker` so the audit log tells an asked-for pass from
        // a scheduled one, and so the retention sweep treats it like any other worker row.
        source: "manual-refresh",
        status: "queued",
        started_at: queuedAt,
        records_seen: 0,
        records_written: 0,
      }),
    });
    return NextResponse.json({ ok: true, status: "queued", state: "queued", requestedAt: queuedAt });
  } catch (error) {
    return NextResponse.json({ ok: false, status: "error", error: error instanceof Error ? error.message : "Could not queue a refresh" }, { status: 502 });
  }
}
