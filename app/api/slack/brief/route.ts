// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The morning brief: the client directory the Slack hub lists, the schedule, and the call that writes one.
 *
 * ── Why generating and sending are the same request ──────────────────────────────────────────────
 * A brief that was written but not sent is not half-done work, it is a preview — and a preview that
 * had to be stored and then referred to by id in a second request would mean a brief could be edited
 * between the two, which is precisely the thing nobody should be able to do to a figure. So the model
 * call and the Slack post happen together, and `destination` decides at the outset which of the four
 * it is: shown on the page, posted to the test channel, or posted to one of the client's own channels.
 *
 * ── Every attempt is recorded, including the failures ────────────────────────────────────────────
 * A row goes into `rr_slack_briefs` whether or not Slack accepted the message, because the question
 * the hub has to answer is "did this client get a brief" and a failed send answers that as firmly as a
 * successful one. The rendered text is stored too, so a brief can be re-read without another model
 * call, and so what was actually said is auditable rather than merely that something was.
 *
 * ── The worker asks this route what is due, rather than working it out itself ─────────────────────
 * The schedule maths and the readiness checks both live in `morning-brief-schedule.ts`, where the tests
 * can reach them. The worker is a plain `.mjs` file that cannot import TypeScript, so rather than keep a
 * second copy of the rules in the worker — which would drift, and would drift silently — GET returns the
 * list of clients that are due right now and the worker's only job is to POST them one at a time.
 */

import { NextResponse } from "next/server";
import { briefTrace, briefUserContent, gatherSignals, type BriefWorkspace } from "../../../lib/morning-brief";
import { BRIEF_MODEL, gatherCall, gatherChannels, morningBriefPrompt, writeBrief } from "../../../lib/morning-brief-run";
import {
  alreadySentToday,
  DEFAULT_SCHEDULE,
  isDueNow,
  readinessOf,
  type BriefSchedule,
} from "../../../lib/morning-brief-schedule";
import { postMessage, slackConfigured, slackReadable, SLACK_TOKEN_ENV, SLACK_USER_TOKEN_ENV, userToken } from "../../../lib/slack";

// One model call at a 40s timeout plus two short Granola calls, inside Hobby's 60s ceiling. No chunking:
// a brief is ~1,400 output tokens by design, and the whole point of it is that it is short enough to read
// before standup.
export const maxDuration = 60;

type Row = Record<string, unknown>;

/** The channel a brief goes to when it is being tried out rather than delivered. */
const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

const AUTOMATION = "morning_brief";

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
      // PostgREST's own message is the whole answer when a column is missing — "column
      // rr_workspaces.granola_title_match does not exist" tells a teammate to run the migration, where
      // "HTTP 400" tells them nothing and sends them here to read this file.
      const detail = (await response.json().catch(() => null)) as { message?: string; hint?: string } | null;
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

async function insertBrief(url: string, key: string, row: Row): Promise<void> {
  await write(url, key, "rr_slack_briefs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

const asNumberList = (value: unknown): number[] =>
  (Array.isArray(value) ? value : []).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

/** The stored schedule, falling back to the built-in one when the row has never been written. */
function scheduleFrom(rows: unknown): BriefSchedule {
  const row = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
  if (!row) return DEFAULT_SCHEDULE;
  const days = asNumberList(row.send_days);
  return {
    enabled: Boolean(row.enabled),
    sendDays: days.length ? days : DEFAULT_SCHEDULE.sendDays,
    sendHour: Number.isFinite(Number(row.send_hour)) ? Number(row.send_hour) : DEFAULT_SCHEDULE.sendHour,
    sendMinute: Number.isFinite(Number(row.send_minute)) ? Number(row.send_minute) : DEFAULT_SCHEDULE.sendMinute,
    timezone: String(row.timezone ?? DEFAULT_SCHEDULE.timezone),
    destination: String(row.destination ?? DEFAULT_SCHEDULE.destination),
  };
}

/**
 * The client directory, the schedule, and which clients are due right now.
 *
 * The five reads run together because the page needs all of them before it can draw anything, and the
 * HeyReach key is read as a list of ids that have one rather than as a column, so no key material is
 * pulled out of the database to answer a question that only needs a yes or no.
 */
export async function GET() {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  try {
    const [workspaceRows, keyedRows, briefRows, granolaRows, automationRows] = await Promise.all([
      read("rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,client_brief,slack_internal_channel_id,slack_external_channel_id,granola_title_match,morning_brief_enabled,last_successful_poll_at&order=name.asc"),
      read("rr_workspaces?select=id&heyreach_api_key_ciphertext=not.is.null"),
      // Every client's brief history in one read rather than one read per client. 200 rows is roughly a
      // year of three-a-week briefs for a dozen clients, and only the newest per client is used.
      read(`rr_slack_briefs?select=workspace_id,created_at,status,destination,slack_channel_id&automation=eq.${AUTOMATION}&order=created_at.desc&limit=200`).catch(() => []),
      read("rr_granola_keys?select=id").catch(() => []),
      read(`rr_slack_automations?select=automation,enabled,send_days,send_hour,send_minute,timezone,destination&automation=eq.${AUTOMATION}&limit=1`).catch(() => []),
    ]);

    const schedule = scheduleFrom(automationRows);
    const granolaKeyCount = Array.isArray(granolaRows) ? granolaRows.length : 0;
    const withHeyreachKey = new Set((Array.isArray(keyedRows) ? (keyedRows as Row[]) : []).map((row) => String(row.id ?? "")));

    const briefs = Array.isArray(briefRows) ? (briefRows as Row[]) : [];
    const latest = new Map<string, Row>();
    // The newest *sent* brief, separately from the newest of any kind: "has this client had one today"
    // must not be satisfied by a preview nobody but the operator saw.
    const latestSent = new Map<string, Row>();
    for (const brief of briefs) {
      const id = String(brief.workspace_id ?? "");
      if (!id) continue;
      if (!latest.has(id)) latest.set(id, brief);
      if (!latestSent.has(id) && String(brief.destination ?? "") !== "preview") latestSent.set(id, brief);
    }

    const now = new Date();
    const due = isDueNow(schedule, now);

    const workspaces = (Array.isArray(workspaceRows) ? (workspaceRows as Row[]) : []).map((workspace) => {
      const id = String(workspace.id ?? "");
      const last = latest.get(id);
      const sent = latestSent.get(id);
      const internalChannelId = String(workspace.slack_internal_channel_id ?? "");
      const externalChannelId = String(workspace.slack_external_channel_id ?? "");
      // Blank means "use the client's own name", which is what the matcher does, so the page and the
      // readiness check have to show the same effective value rather than an empty field.
      const granolaTitleMatch = String(workspace.granola_title_match ?? "").trim() || String(workspace.name ?? "");
      const enabled = Boolean(workspace.morning_brief_enabled);
      const readiness = readinessOf({
        heyreachKeyConfigured: withHeyreachKey.has(id),
        lastSuccessfulPollAt: workspace.last_successful_poll_at ? String(workspace.last_successful_poll_at) : null,
        internalChannelId,
        externalChannelId,
        granolaTitleMatch,
        granolaKeyCount,
      }, now.getTime());
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
        morningBriefEnabled: enabled,
        hasBrief: Boolean(String(workspace.client_brief ?? "").trim()),
        readiness,
        sentToday,
        lastBriefAt: last ? String(last.created_at ?? "") : null,
        lastBriefStatus: last ? String(last.status ?? "") : null,
        lastBriefDestination: last ? String(last.destination ?? "") : null,
        // The worker reads this rather than recomputing it. Readiness is required as well as the toggle:
        // an enabled client whose HeyReach sync died should not post a brief built from two sources
        // while the page says three, it should show as not ready until somebody looks.
        dueNow: due && enabled && readiness.ready && !sentToday,
      };
    });

    return NextResponse.json({
      ok: true,
      // Reading and posting are reported apart because they break apart: a user token with no bot token
      // can read every channel and post to none, and a page that said "Slack: connected" would be lying
      // about half of it.
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

/** The schedule, and which clients are opted in. Two small writes rather than a settings blob. */
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
      const destination = input.destination === "internal" || input.destination === "external" ? String(input.destination) : "test";
      // An enabled automation with no days would look on and never fire, which is the worst of both.
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
        body: JSON.stringify({ morning_brief_enabled: Boolean(body.enabled) }),
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
    destination = body.destination === "test" || body.destination === "internal" || body.destination === "external" ? body.destination : "preview";
    if (!slug) return NextResponse.json({ error: "No client was named." }, { status: 400 });

    const rows = await read(`rr_workspaces?select=id,name,slug,timezone,client_brief,slack_internal_channel_id,slack_external_channel_id,granola_title_match&slug=eq.${encodeURIComponent(slug)}&limit=1`);
    const found = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
    if (!found) return NextResponse.json({ error: "That client does not exist." }, { status: 404 });
    workspace = found as BriefWorkspace;

    // Worked out before the model call, so a brief that has nowhere to go costs nothing to refuse.
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

    // All four sources at once. The call is the slowest and the most likely to be missing, and it is the
    // one that must not hold up or fail the other three — `gatherCall` never throws.
    const [signals, channels, call, systemPrompt] = await Promise.all([
      gatherSignals(read, workspace),
      gatherChannels(workspace),
      gatherCall(read, workspace),
      morningBriefPrompt(workspace.slug),
    ]);

    const inputs = { signals, ...channels, call: call.call, callReason: call.callReason };
    const content = briefUserContent(workspace, inputs);
    const body_ = await writeBrief(systemPrompt, content);

    let messageTs = "";
    let sendError = "";
    if (channelId) {
      try {
        messageTs = await postMessage(channelId, body_);
      } catch (error) {
        // The brief itself succeeded, so it is returned and stored either way — the send is what failed,
        // and saying which of the two went wrong is the difference between a fixable error and a mystery.
        sendError = error instanceof Error ? error.message : "Slack refused the message.";
      }
    }

    // `sources` rides along in the same column as the figures because it is the same kind of fact: what
    // the model was given. A brief that reads thinly is then explainable a week later without guessing.
    const sources = {
      internalMessages: channels.internal.messages,
      externalMessages: channels.external.messages,
      call: call.call ? { title: call.call.title, ageDays: call.call.ageDays, owner: call.call.owner, transcriptChars: call.call.transcript.length } : null,
      callReason: call.callReason ?? null,
    };

    // Returned, not stored. The trace quotes the transcript and both channels verbatim, and a row that
    // carried those would be putting a copy of every client call in a table nobody remembers is there.
    // `sources` above is the durable record, and it is figures only.
    const steps = briefTrace(workspace, inputs, {
      model: BRIEF_MODEL,
      promptChars: systemPrompt.length,
      contentChars: content.length,
      briefChars: body_.length,
      destination,
      channelId,
      posted: Boolean(messageTs),
      sendError,
    });

    await insertBrief(url, key, {
      workspace_id: workspace.id,
      automation: AUTOMATION,
      destination,
      slack_channel_id: channelId || null,
      slack_message_ts: messageTs || null,
      body: body_,
      signals: { ...signals, sources },
      status: sendError ? "error" : "success",
      error_text: sendError || null,
    });

    return NextResponse.json({
      ok: !sendError,
      brief: body_,
      signals,
      sources,
      steps,
      posted: Boolean(messageTs),
      channelId: channelId || null,
      messageTs: messageTs || null,
      channelNotes: [channels.internal.error, channels.external.error, ...call.errors].filter(Boolean),
      error: sendError || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The brief could not be written.";
    if (workspace) {
      await insertBrief(url, key, {
        workspace_id: workspace.id,
        automation: AUTOMATION,
        destination,
        body: "",
        status: "error",
        error_text: message,
      });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
