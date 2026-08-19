// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The call analysis: the client directory the Slack hub lists for it, the schedule, and the call that
 * writes one.
 *
 * ── The morning brief's sibling, deliberately built the same way ─────────────────────────────────
 * This route is the second Slack automation, and it shares the brief's shape on purpose: generating and
 * sending are one request so a written analysis can never be edited between the two; every attempt is
 * logged to `rr_slack_briefs` whether Slack accepted it or not; and the worker asks GET what is due
 * rather than keeping a second copy of the schedule maths it cannot import. What differs is the input and
 * the reach. A call analysis reads one source, the transcript Granola captured of the weekly call, so
 * there is no HeyReach in it. It files what it writes into the base's Weekly Calls table, the third
 * tracker, rather than into the campaign and project tables the brief keeps. And unlike a brief, it may
 * go to the client's external channel: a brief is the team's own outstanding-work list, but a call
 * summary is a thing a client is often glad to receive, so internal is the default and external is an
 * offered choice.
 *
 * ── Why it reuses the brief's tables with no new schema ──────────────────────────────────────────
 * `rr_slack_automations` is keyed by automation name and `rr_slack_briefs` carries an `automation`
 * column, so both hold a second automation with nothing added. The only new column anywhere is
 * `rr_workspaces.call_analysis_enabled`, the opt-in switch, sat beside `morning_brief_enabled`.
 */

import { NextResponse } from "next/server";
import { briefFraming, type BriefWorkspace } from "../../../lib/morning-brief";
import { gatherCalls, gatherChannels, writeBrief } from "../../../lib/morning-brief-run";
import { brainContext } from "../../../lib/brain-context";
import { callAnalysisHeaderText, callAnalysisUserContent, type CallAnalysisDestination, type CallAnalysisInputs } from "../../../lib/call-analysis";
import { callAnalysisPrompt, fileWeeklyCall, fileWeeklyCallToBrain, type WeeklyCallFileResult } from "../../../lib/call-analysis-run";
import {
  alreadySentToday,
  callReadinessOf,
  DEFAULT_SCHEDULE,
  isDueNow,
  type BriefSchedule,
} from "../../../lib/morning-brief-schedule";
import { postMessage, slackConfigured, slackReadable, SLACK_TOKEN_ENV, SLACK_USER_TOKEN_ENV, userToken } from "../../../lib/slack";

/** One model call plus a transcript fetch, comfortably inside Hobby's ceiling — see the brief's note. */
export const maxDuration = 60;

type Row = Record<string, unknown>;

/** The channel an analysis goes to when it is being tried out rather than delivered. */
const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

const AUTOMATION = "call_analysis";

/** Where a scheduled call analysis lands. Internal by default; external is the only other allowed value. */
const DEFAULT_CALL_DESTINATION = "internal";

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
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(detail?.message ? `Supabase refused the read: ${detail.message}` : `Supabase refused the read: HTTP ${response.status}`);
    }
    return response.json();
  };
}

async function write(url: string, key: string, path: string, init: RequestInit): Promise<Response | null> {
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  }).catch(() => null);
}

async function insertRun(url: string, key: string, row: Row): Promise<void> {
  await write(url, key, "rr_slack_briefs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

const asNumberList = (value: unknown): number[] =>
  (Array.isArray(value) ? value : []).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

/** Internal unless the row explicitly says external. A stale or unknown value falls back to internal. */
const cleanDestination = (value: unknown): string => (value === "external" ? "external" : DEFAULT_CALL_DESTINATION);

/** The stored schedule, falling back to the built-in one when the row has never been written. */
function scheduleFrom(rows: unknown): BriefSchedule {
  const row = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
  if (!row) return { ...DEFAULT_SCHEDULE, destination: DEFAULT_CALL_DESTINATION };
  const days = asNumberList(row.send_days);
  return {
    enabled: Boolean(row.enabled),
    sendDays: days.length ? days : DEFAULT_SCHEDULE.sendDays,
    sendHour: Number.isFinite(Number(row.send_hour)) ? Number(row.send_hour) : DEFAULT_SCHEDULE.sendHour,
    sendMinute: Number.isFinite(Number(row.send_minute)) ? Number(row.send_minute) : DEFAULT_SCHEDULE.sendMinute,
    timezone: String(row.timezone ?? DEFAULT_SCHEDULE.timezone),
    // Read from the row here, unlike the morning brief, because a call analysis legitimately goes to one
    // of two channels and the team picks which. Clamped to the two allowed values so a stale row can only
    // ever resolve to internal, never to somewhere nobody can see.
    destination: cleanDestination(row.destination),
  };
}

/**
 * The client directory, the schedule, and which clients are due a call analysis right now.
 *
 * Fewer reads than the brief's GET because a call analysis has fewer sources: the clients, the Granola
 * key count, this automation's own run history, and its schedule. No HeyReach key list, because the
 * analysis does not touch HeyReach.
 */
export async function GET() {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  try {
    const [workspaceRows, runRows, granolaRows, automationRows] = await Promise.all([
      read("rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,client_brief,slack_internal_channel_id,slack_external_channel_id,granola_title_match,call_analysis_enabled&order=name.asc")
        .catch(() => read("rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,client_brief,slack_internal_channel_id,slack_external_channel_id,granola_title_match&order=name.asc")),
      read(`rr_slack_briefs?select=workspace_id,created_at,status,destination,slack_channel_id&automation=eq.${AUTOMATION}&order=created_at.desc&limit=200`).catch(() => []),
      read("rr_granola_keys?select=id").catch(() => []),
      read(`rr_slack_automations?select=automation,enabled,send_days,send_hour,send_minute,timezone,destination&automation=eq.${AUTOMATION}&limit=1`).catch(() => []),
    ]);

    const schedule = scheduleFrom(automationRows);
    const granolaKeyCount = Array.isArray(granolaRows) ? granolaRows.length : 0;

    const runs = Array.isArray(runRows) ? (runRows as Row[]) : [];
    const latest = new Map<string, Row>();
    const latestSent = new Map<string, Row>();
    for (const run of runs) {
      const id = String(run.workspace_id ?? "");
      if (!id) continue;
      if (!latest.has(id)) latest.set(id, run);
      if (!latestSent.has(id) && String(run.destination ?? "") !== "preview") latestSent.set(id, run);
    }

    const now = new Date();
    const due = isDueNow(schedule, now);

    const workspaces = (Array.isArray(workspaceRows) ? (workspaceRows as Row[]) : []).map((workspace) => {
      const id = String(workspace.id ?? "");
      const last = latest.get(id);
      const sent = latestSent.get(id);
      const internalChannelId = String(workspace.slack_internal_channel_id ?? "");
      const externalChannelId = String(workspace.slack_external_channel_id ?? "");
      const granolaTitleMatch = String(workspace.granola_title_match ?? "").trim() || String(workspace.name ?? "");
      const enabled = Boolean(workspace.call_analysis_enabled);
      const readiness = callReadinessOf({ internalChannelId, externalChannelId, granolaTitleMatch, granolaKeyCount });
      const sentToday = alreadySentToday(sent ? String(sent.created_at ?? "") : null, schedule, now);
      return {
        id,
        name: String(workspace.name ?? ""),
        slug: String(workspace.slug ?? ""),
        logoUrl: workspace.logo_url ?? null,
        accentColor: workspace.accent_color ?? null,
        internalChannelId,
        externalChannelId,
        granolaTitleMatch,
        callAnalysisEnabled: enabled,
        readiness,
        sentToday,
        lastBriefAt: last ? String(last.created_at ?? "") : null,
        lastBriefStatus: last ? String(last.status ?? "") : null,
        lastBriefDestination: last ? String(last.destination ?? "") : null,
        dueNow: due && enabled && readiness.ready && !sentToday,
      };
    });

    return NextResponse.json({
      ok: true,
      slack: {
        configured: slackConfigured(),
        readable: slackReadable(),
        readsAsUser: Boolean(userToken()),
        tokenEnv: SLACK_TOKEN_ENV,
        userTokenEnv: SLACK_USER_TOKEN_ENV,
        testChannelId: (process.env[TEST_CHANNEL_ENV] ?? "").trim(),
      },
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      granolaKeyCount,
      schedule,
      scheduleDueNow: due,
      workspaces,
      due: workspaces.filter((workspace) => workspace.dueNow).map((workspace) => workspace.slug),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load the client list." }, { status: 502 });
  }
}

/** The schedule, and which clients are opted in. Same two small writes the brief's PATCH makes. */
export async function PATCH(request: Request) {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const body = (await request.json().catch(() => ({}))) as Row;

  try {
    if (body.schedule && typeof body.schedule === "object") {
      const input = body.schedule as Row;
      const days = asNumberList(input.sendDays);
      const hour = Math.min(23, Math.max(0, Math.round(Number(input.sendHour) || 0)));
      const minute = Math.min(59, Math.max(0, Math.round(Number(input.sendMinute) || 0)));
      const destination = cleanDestination(input.destination);
      if (input.enabled && !days.length) return NextResponse.json({ error: "Pick at least one day, or switch the automation off." }, { status: 400 });
      const response = await write(url, key, "rr_slack_automations", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          automation: AUTOMATION,
          enabled: Boolean(input.enabled),
          send_days: days.length ? days : DEFAULT_SCHEDULE.sendDays,
          send_hour: hour,
          send_minute: minute,
          timezone: String(input.timezone ?? DEFAULT_SCHEDULE.timezone),
          destination,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!response?.ok) {
        const detail = (await response?.json().catch(() => null)) as { message?: string } | null;
        return NextResponse.json({ error: detail?.message ?? "The schedule could not be saved." }, { status: 502 });
      }
      return NextResponse.json({ ok: true });
    }

    if (typeof body.workspace === "string") {
      const response = await write(url, key, `rr_workspaces?slug=eq.${encodeURIComponent(body.workspace)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ call_analysis_enabled: Boolean(body.enabled) }),
      });
      if (!response?.ok) {
        const detail = (await response?.json().catch(() => null)) as { message?: string } | null;
        return NextResponse.json({ error: detail?.message ?? "That client could not be updated." }, { status: 502 });
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The change could not be saved." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  let workspace: BriefWorkspace | null = null;
  let destination = "preview";

  try {
    const body = (await request.json().catch(() => ({}))) as Row;
    const slug = typeof body.workspace === "string" ? body.workspace.trim() : "";
    // Four, not three: a call analysis may go to the client's external channel, which the brief may not.
    // `internal` and `external` are the scheduler's and the operator's choices; `test` and `preview` are
    // for checking the prompt. Anything else falls back to a preview that posts nowhere.
    destination = ["test", "internal", "external"].includes(String(body.destination)) ? String(body.destination) : "preview";
    if (!slug) return NextResponse.json({ error: "No client was named." }, { status: 400 });

    const columns = "id,name,slug,timezone,client_brief,brain_folder,slack_internal_channel_id,slack_external_channel_id,granola_title_match,airtable_base_id";
    const rows = await read(`rr_workspaces?select=${columns},slack_extra_channel_ids,granola_extra_title_matches&slug=eq.${encodeURIComponent(slug)}&limit=1`)
      .catch(() => read(`rr_workspaces?select=${columns}&slug=eq.${encodeURIComponent(slug)}&limit=1`));
    const found = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
    if (!found) return NextResponse.json({ error: "That client does not exist." }, { status: 404 });
    workspace = found as BriefWorkspace;

    // Worked out before the model call, so an analysis with nowhere to go costs nothing to refuse.
    let channelId = "";
    if (destination === "test") {
      channelId = (process.env[TEST_CHANNEL_ENV] ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${TEST_CHANNEL_ENV} is not set, so there is no test channel to post to.` }, { status: 400 });
    }
    if (destination === "internal") {
      channelId = String(workspace.slack_internal_channel_id ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${workspace.name} has no internal channel id. Add one on their configuration page.` }, { status: 400 });
    }
    if (destination === "external") {
      channelId = String(workspace.slack_external_channel_id ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${workspace.name} has no external channel id. Add one on their configuration page.` }, { status: 400 });
    }
    if (channelId && !slackConfigured()) {
      return NextResponse.json({ error: `${SLACK_TOKEN_ENV} is not set, so nothing can be posted to Slack.` }, { status: 400 });
    }

    // The transcript, the prompt, the channel roster and the QC Brain in parallel. `gatherCalls`,
    // `gatherChannels` and `brainContext` never throw — a missing source is a recap that leaves that
    // section out, not a failed run. The channels are read only for the people in them: the recap names
    // an action item owner and needs the mention codes to notify them, the same roster the brief uses.
    const [call, systemPrompt, channels, brain] = await Promise.all([
      gatherCalls(read, workspace),
      callAnalysisPrompt(workspace.slug),
      gatherChannels(workspace),
      brainContext(workspace),
    ]);

    // Name and id together, so the recap can turn "Kori will send it" into a mention Kori is notified by.
    const people = [...(channels.internal.people ?? []), ...(channels.external.people ?? [])];

    const inputs: CallAnalysisInputs = {
      call: call.call,
      callReason: call.callReason,
      extraCalls: call.extras,
      brief: String((workspace as Row).client_brief ?? ""),
      brain: brain.block,
      people,
    };
    const content = callAnalysisUserContent(workspace, inputs);
    // Framed the same way the brief is — each heading fenced and centred — so the two automations read
    // alike in Slack and the website's parser turns both back into the same document. No weekday footer:
    // that is a morning-brief ritual, and a call analysis is a record of one meeting, not a daily note.
    const body_ = briefFraming(await writeBrief(systemPrompt, content));

    // The header names the day of the call, not today: a recap of Monday's sync run on Wednesday is still
    // Monday's, and `startedAt` is epoch millis from Granola. No call means nothing was posted anyway, so
    // the fallback to now never actually reaches Slack.
    const headerDate = call.call ? new Date(call.call.startedAt) : new Date();

    let messageTs = "";
    let analysisTs = "";
    let sendError = "";
    if (channelId) {
      try {
        messageTs = await postMessage(channelId, callAnalysisHeaderText(workspace, headerDate));
        analysisTs = await postMessage(channelId, body_, messageTs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Slack refused the message.";
        sendError = messageTs ? `The header posted but the analysis did not: ${detail}` : detail;
      }
    }
    const posted = Boolean(analysisTs);

    // The call's own facts ride along so a manual run can show which meeting it read: the date, who was on
    // it, and how long it ran. `startedAt` is epoch millis; the UI turns it into a date in the client's zone.
    const sources = {
      call: call.call
        ? {
            // The Granola note id, so the hourly heartbeat can tell a call it has already posted from a
            // genuinely new one and never post the same meeting twice.
            noteId: call.call.noteId,
            title: call.call.title,
            startedAt: call.call.startedAt,
            ageDays: call.call.ageDays,
            owner: call.call.owner,
            attendees: call.call.attendees,
            durationMinutes: call.call.durationMinutes,
            transcriptChars: call.call.transcript.length,
          }
        : null,
      extraCalls: call.extras.map((extra) => ({ title: extra.title, ageDays: extra.ageDays, owner: extra.owner, transcriptChars: extra.transcript.length })),
      callReason: call.callReason ?? null,
    };

    // File the recap into the client's Weekly Calls table, keyed on the call so a re-run updates rather
    // than duplicates. After posting and non-fatal by design: a base that is unmapped or missing the table
    // is a note in the trace, never a failed recap. Skipped when there is no call to file.
    // The mention roster the recap was written against: name and id together, so `<@U…>` codes resolve to
    // names both on the website and in the plain-text recap the Weekly Calls row stores.
    const mentions = Object.fromEntries(people.map((person) => [person.id, person.name]));

    // Filed to both the Airtable Weekly Calls table and the client's QC Brain folder, in parallel and
    // independently: the base is the operational record, the brain is the agency's shared memory, and one
    // being unmapped or unreachable must not stop the other. Both mirror the same fields off the same call;
    // the brain also gets the full untruncated transcript. Skipped entirely when there was no call to file.
    const baseId = String((workspace as Row).airtable_base_id ?? "").trim();
    const [filing, brainFiling]: [WeeklyCallFileResult, WeeklyCallFileResult] = call.call
      ? await Promise.all([
          fileWeeklyCall(baseId, workspace, { call: call.call, recap: body_, destination: destination as CallAnalysisDestination, mentions }),
          fileWeeklyCallToBrain(workspace, { call: call.call, recap: body_, destination: destination as CallAnalysisDestination, mentions }),
        ])
      : [{ filed: null, note: "" }, { filed: null, note: "" }];
    const filingNotes = [filing.note, brainFiling.note].filter(Boolean);

    await insertRun(url, key, {
      workspace_id: workspace.id,
      automation: AUTOMATION,
      destination,
      slack_channel_id: channelId || null,
      slack_message_ts: analysisTs || null,
      body: body_,
      signals: {
        sources,
        weeklyCall: { filed: filing.filed, note: filing.note || null },
        weeklyCallBrain: { filed: brainFiling.filed, note: brainFiling.note || null },
      },
      status: sendError ? "error" : "success",
      error_text: sendError || null,
    });

    return NextResponse.json({
      ok: !sendError,
      brief: body_,
      // The mention roster the recap was written against, so the website renders `<@U…>` as `@name` the
      // same way the morning brief does. Action item owners are the agency team, who are in these channels.
      mentions,
      sources,
      posted,
      channelId: channelId || null,
      messageTs: analysisTs || null,
      threadTs: messageTs || null,
      channelNotes: [...call.errors, ...filingNotes].filter(Boolean),
      error: sendError || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The call analysis could not be written.";
    if (workspace) {
      await insertRun(url, key, {
        workspace_id: workspace.id,
        automation: AUTOMATION,
        destination,
        body: "",
        status: "error",
        error_text: message,
      });
    }
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
