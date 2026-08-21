// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Granola heartbeat: once an hour, in working hours, ask Granola what calls it can see for each client
 * that has call analysis switched on, and say which of those calls are new.
 *
 * ── Why this is a poll and not the call analysis itself ──────────────────────────────────────────
 * A call analysis reads a transcript, calls a model and posts to Slack — a heavy thing to do to fifteen
 * clients on the off chance one had a call. This route does the cheap half only: one list pass across every
 * Granola key, matched against each client's title, stopping at the note id and title without ever opening a
 * transcript. It returns the slugs whose newest call has not been posted yet, and the worker turns each of
 * those into one real analysis. So the expensive work only happens for a call that actually exists and has
 * not been seen, and the poll that finds it is light enough to run every hour.
 *
 * ── Why the window is enforced here ──────────────────────────────────────────────────────────────
 * The worker calls this hourly regardless of the time. Whether it is working hours is a fact about the
 * clock, computed in one place, so this route decides it: outside 5am–8pm Eastern it records nothing and
 * returns `inWindow: false`, and the worker does nothing. That is what keeps the health page's "down" verdict
 * honest — a stored heartbeat only ever exists for a poll that was supposed to happen.
 *
 * ── Why it writes its own row ────────────────────────────────────────────────────────────────────
 * `rr_granola_heartbeats` is this poll's own log: what it saw each hour, so the health page can show the
 * calls it found and judge the connection down when the row stops being written. The route writes it because
 * the route is what did the looking; the worker only asks and then acts on the answer.
 */

import { NextResponse } from "next/server";
import { CALL_WINDOW_DAYS, type BriefWorkspace } from "../../../lib/morning-brief";
import { granolaKeys } from "../../../lib/morning-brief-run";
import { latestCallsAcrossKeys } from "../../../lib/granola";
import { callReadinessOf } from "../../../lib/morning-brief-schedule";
import { GRANOLA_TIMEZONE, inGranolaWindow, selectNewCalls, type HeartbeatSighting } from "../../../lib/granola-heartbeat";

/** One list pass across every key, comfortably inside Hobby's ceiling — no model call, no transcript. */
export const maxDuration = 60;

type Row = Record<string, unknown>;

function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function reader(url: string, key: string) {
  return async (path: string): Promise<unknown> => {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Supabase refused the read: HTTP ${response.status}`);
    return response.json();
  };
}

async function insertHeartbeat(url: string, key: string, row: Row): Promise<void> {
  await fetch(`${url}/rest/v1/rr_granola_heartbeats`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
    cache: "no-store",
  }).catch(() => null);
}

/**
 * The note ids of every call analysis already posted, so a call is only ever posted once.
 *
 * Read from `rr_slack_briefs`, where each delivered call analysis stores its call's note id under
 * `signals.sources.call.noteId`. Previews are counted too: a preview does not post to a channel, but it did
 * read that call, and the point of the id is "has this meeting been turned into an analysis," which a preview
 * satisfies. The set is what stops the hourly poll from re-posting the same call every hour it stays newest.
 *
 * Errored runs are the one thing left out. A run whose Slack post threw — the bot not in the channel, a stale
 * channel id — still wrote a row with the note id, and counting it would mark the call posted when it never
 * reached anyone: the recap lands in the QC Brain and nowhere else, silently, forever. Skipping error rows
 * lets the next hour retry, so a call that failed to post is picked up again once the channel is fixed.
 */
function postedNoteIdsFrom(rows: unknown): Set<string> {
  const ids = new Set<string>();
  for (const row of Array.isArray(rows) ? (rows as Row[]) : []) {
    if (String(row.status ?? "") === "error") continue;
    const signals = (row.signals ?? {}) as Row;
    const sources = (signals.sources ?? {}) as Row;
    const call = (sources.call ?? {}) as Row;
    const noteId = String(call.noteId ?? "").trim();
    if (noteId) ids.add(noteId);
  }
  return ids;
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  const now = new Date();
  const credential = credentials();
  if (!credential) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;

  // Outside the window the poll does not run and nothing is written: a stored heartbeat only ever means a
  // poll that was due. The worker reads `inWindow` and stands down.
  if (!inGranolaWindow(now, GRANOLA_TIMEZONE)) {
    return NextResponse.json({ ok: true, inWindow: false, checkedAt, timezone: GRANOLA_TIMEZONE, newCalls: [], clients: [] });
  }

  const read = reader(url, key);
  try {
    const [workspaceRows, briefRows, keys] = await Promise.all([
      read("rr_workspaces?select=id,name,slug,timezone,slack_internal_channel_id,slack_external_channel_id,granola_title_match,call_analysis_enabled&order=name.asc")
        .catch(() => read("rr_workspaces?select=id,name,slug,timezone,slack_internal_channel_id,slack_external_channel_id,granola_title_match&order=name.asc")),
      read(`rr_slack_briefs?select=signals,status&automation=eq.call_analysis&order=created_at.desc&limit=500`).catch(() => []),
      granolaKeys(read),
    ]);

    const postedNoteIds = postedNoteIdsFrom(briefRows);

    // Only clients that have opted in and are in a fit state to receive an analysis: a call found for a
    // client with no internal channel or no title to match on has nowhere to go and nothing to be sure it
    // is theirs, so it is not polled for. Same readiness rule the call-analysis page draws.
    const ready = (Array.isArray(workspaceRows) ? (workspaceRows as Row[]) : [])
      .map((workspace) => {
        const internalChannelId = String(workspace.slack_internal_channel_id ?? "");
        const externalChannelId = String(workspace.slack_external_channel_id ?? "");
        const granolaTitleMatch = String(workspace.granola_title_match ?? "").trim() || String(workspace.name ?? "");
        const readiness = callReadinessOf({ internalChannelId, externalChannelId, granolaTitleMatch, granolaKeyCount: keys.length });
        return {
          id: String(workspace.id ?? ""),
          name: String(workspace.name ?? ""),
          slug: String(workspace.slug ?? ""),
          titleMatch: (workspace as BriefWorkspace).granola_title_match ?? workspace.name,
          enabled: Boolean(workspace.call_analysis_enabled),
          ready: readiness.ready,
        };
      })
      .filter((workspace) => workspace.enabled && workspace.ready && workspace.slug);

    const { found, keysSeen, errors } = await latestCallsAcrossKeys(
      keys,
      ready.map((workspace) => ({ slug: workspace.slug, titleMatch: workspace.titleMatch, clientName: workspace.name })),
      CALL_WINDOW_DAYS,
    );

    const sightings: HeartbeatSighting[] = ready.map((workspace) => {
      const sighting = found[workspace.slug] ?? null;
      const noteId = sighting?.noteId ?? null;
      return {
        slug: workspace.slug,
        name: workspace.name,
        noteId,
        title: sighting?.title ?? null,
        startedAt: sighting?.startedAt ?? null,
        ageDays: sighting?.ageDays ?? null,
        owner: sighting?.owner ?? null,
        isNew: Boolean(noteId && !postedNoteIds.has(noteId)),
      };
    });

    const newCalls = selectNewCalls(sightings, postedNoteIds);
    const callsFound = sightings.filter((sighting) => sighting.noteId).length;

    await insertHeartbeat(url, key, {
      checked_at: checkedAt,
      in_window: true,
      keys_seen: keysSeen,
      clients_checked: ready.length,
      calls_found: callsFound,
      new_calls: newCalls.length,
      status: errors.length && !callsFound ? "error" : "ok",
      clients: sightings,
      error_text: errors.length ? errors.join(" · ").slice(0, 1000) : null,
    });

    return NextResponse.json({
      ok: true,
      inWindow: true,
      checkedAt,
      timezone: GRANOLA_TIMEZONE,
      keysSeen,
      clientsChecked: ready.length,
      callsFound,
      newCalls,
      clients: sightings,
      errors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Granola heartbeat could not be read.";
    await insertHeartbeat(url, key, {
      checked_at: checkedAt,
      in_window: true,
      keys_seen: 0,
      clients_checked: 0,
      calls_found: 0,
      new_calls: 0,
      status: "error",
      clients: [],
      error_text: message.slice(0, 1000),
    });
    return NextResponse.json({ ok: false, inWindow: true, checkedAt, error: message }, { status: 502 });
  }
}
