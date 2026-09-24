// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Whether each client's calls actually turn up in Granola, and on whose keys.
 *
 * ── Why this is its own route, asked for by the page ─────────────────────────────────────────────
 * The automations directory (`/api/slack/brief`, `/api/slack/call-analysis`) is also what the worker reads
 * to decide which briefs are due, and it is read often. Putting a Granola list pass into it would spend every
 * key's rate limit on the worker's checks, and tying `ready` to "a call was found" would stop a client's brief
 * the week they had no call — which the brief is built to survive. So the page asks this separately, the
 * worker never does, and nothing here changes whether anything is sent.
 */

import { NextResponse } from "next/server";
import { CALL_WINDOW_DAYS } from "../../../lib/morning-brief";
import { granolaKeys } from "../../../lib/morning-brief-run";
import { callCoverage } from "../../../lib/granola";

/** One list pass across every key, up to three pages each; no transcript is opened. */
export const maxDuration = 60;

type Row = Record<string, unknown>;

function reader(url: string, key: string) {
  return async (path: string): Promise<unknown> => {
    const response = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`Supabase refused the read: HTTP ${response.status}`);
    return response.json();
  };
}

export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const read = reader(url, key);
  try {
    const [workspaceRows, keys] = await Promise.all([
      read("rr_workspaces?select=name,slug,granola_title_match&slug=neq.misc&order=name.asc"),
      granolaKeys(read),
    ]);
    const clients = (Array.isArray(workspaceRows) ? (workspaceRows as Row[]) : [])
      .map((workspace) => ({ slug: String(workspace.slug ?? ""), titleMatch: workspace.granola_title_match ?? workspace.name, clientName: workspace.name }))
      .filter((client) => client.slug);
    const { coverage, keysSeen, errors } = await callCoverage(keys, clients, CALL_WINDOW_DAYS);
    return NextResponse.json({ ok: true, windowDays: CALL_WINDOW_DAYS, keysSeen, keyLabels: keys.map((k) => k.label), errors, coverage });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Granola could not be checked." }, { status: 502 });
  }
}
