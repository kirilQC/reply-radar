// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The morning brief: the client directory the Slack hub lists, the schedule, and the call that writes one.
 *
 * ── Why generating and sending are the same request ──────────────────────────────────────────────
 * A brief that was written but not sent is not half-done work, it is a preview — and a preview that
 * had to be stored and then referred to by id in a second request would mean a brief could be edited
 * between the two, which is precisely the thing nobody should be able to do to a figure. So the model
 * call and the Slack post happen together, and `destination` decides at the outset which of the three
 * it is: shown on the page, posted to the test channel, or posted to the client's internal channel. There
 * is no fourth. The brief is the team's own outstanding-work list, so a client-facing channel was never a
 * destination worth offering — it was only ever a way to send the wrong people the wrong document.
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
import { briefHeaderText, briefTrace, briefUserContent, briefWithFooter, gatherSignals, type BriefWorkspace } from "../../../lib/morning-brief";
import { BRIEF_MODEL, gatherCalls, gatherChannels, gatherLiveFigures, gatherPriorBriefs, morningBriefPrompt, writeBrief } from "../../../lib/morning-brief-run";
import { brainContext } from "../../../lib/brain-context";
import {
  alreadySentToday,
  DEFAULT_SCHEDULE,
  isDueNow,
  localDayKey,
  readinessOf,
  type BriefSchedule,
} from "../../../lib/morning-brief-schedule";
import { isAirtableConfigured } from "../../../lib/airtable";
import { extractTrackerItems } from "../../../lib/tracker-extract";
import { openItems } from "../../../lib/tracker-sync";
import { readTrackers, syncTrackers } from "../../../lib/tracker-sync-run";
import { postMessage, slackConfigured, slackReadable, SLACK_TOKEN_ENV, SLACK_USER_TOKEN_ENV, userToken } from "../../../lib/slack";

/*
 * Sixty seconds is the ceiling and asking for more does not buy it — see the note in `brain-icp.ts`.
 * That is the whole reason the tracker step below runs on a budget rather than unconditionally: the
 * brief is one model call plus the source reads, and the tracker step is a second model call plus two
 * Airtable round trips, and the two together do not always fit. So the brief is written and posted
 * first, and the tracker step gets whatever is left. Running out of time skips it with a note rather
 * than killing the function, because a brief that was delivered must not come back as a failed run.
 */
export const maxDuration = 60;

/**
 * How much of the sixty seconds has to be left before the tracker step is worth starting.
 *
 * A second model call and two Airtable round trips: `TRACKER_MODEL_MS` for the extraction, then the
 * schema read, two record reads and up to six writes. Starting it with less than this is starting
 * something that will be cut off mid-write, which is the one outcome worth avoiding — a half-applied
 * plan is a tracker nobody can reason about.
 */
const TRACKER_BUDGET_MS = 30_000;
const TRACKER_MODEL_MS = 20_000;

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
    // Not read from the row. Rows written before the destination stopped being a choice still say `test`
    // or `external`, and honouring one of those would mean the schedule kept posting somewhere nobody can
    // now see on the page — or, worse, into a channel the client reads.
    destination: DEFAULT_SCHEDULE.destination,
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
      // Not read from the request. A scheduled brief goes to the client's internal channel and nowhere
      // else; the column stays because every stored brief records where it went, but it is no longer a
      // choice anybody has to make on the page.
      const destination = "internal";
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
  // Taken before anything is read, because what the tracker step needs to know is how much of the
  // function's sixty seconds is gone, not how long the model took.
  const startedAt = Date.now();

  try {
    const body = (await request.json().catch(() => ({}))) as Row;
    const slug = typeof body.workspace === "string" ? body.workspace.trim() : "";
    // `internal` is here for the scheduler, which is the only caller that asks for it — the page offers a
    // preview and the test channel, because a person clicking Generate is checking the prompt, not sending
    // the team their Monday brief by hand.
    destination = body.destination === "test" || body.destination === "internal" ? body.destination : "preview";
    if (!slug) return NextResponse.json({ error: "No client was named." }, { status: 400 });

    // Two selects, because the extra-source columns are an additive migration and PostgREST fails the
    // whole read over one unknown column. A database without the migration still writes briefs; it just
    // writes them from the two channels and the one call, which is what it had before.
    const columns = "id,name,slug,timezone,client_brief,brain_folder,slack_internal_channel_id,slack_external_channel_id,granola_title_match,heyreach_api_key_ciphertext";
    const rows = await read(`rr_workspaces?select=${columns},slack_extra_channel_ids,granola_extra_title_matches,airtable_base_id&slug=eq.${encodeURIComponent(slug)}&limit=1`)
      .catch(() => read(`rr_workspaces?select=${columns}&slug=eq.${encodeURIComponent(slug)}&limit=1`));
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
    if (channelId && !slackConfigured()) {
      return NextResponse.json({ error: `${SLACK_TOKEN_ENV} is not set, so nothing can be posted to Slack.` }, { status: 400 });
    }

    // Every source at once. The calls are the slowest and the most likely to be missing, and they must not
    // hold up or fail the others — neither `gatherCalls` nor `brainContext` ever throws. The QC Brain is a
    // GitHub read rather than a database one, which is why it is a fifth request and not part of the row
    // above: it is the agency's own written record of this client, and it is what turns a figure that
    // dropped into a figure that dropped against a plan.
    /*
     * HeyReach is asked first, and its answer decides whether the stored figures are read at all.
     *
     * Not part of the batch below, because `gatherSignals` needs the answer: given a live one it does not
     * touch `rr_campaign_stats` or `rr_daily_stats`, and given a failure it reads them and the brief says
     * on its face that the numbers are a copy. Two sources for one figure would mean the brief eventually
     * states the wrong one with no way to tell which.
     *
     * Sequential rather than parallel costs a second or two of the sixty. Worth it: everything after this
     * point is either cheap or already parallel, and the alternative is starting the stored reads for every
     * client on every run to throw them away.
     */
    const live = await gatherLiveFigures(String((found as Row).heyreach_api_key_ciphertext ?? ""));
    const [signals, channels, call, systemPrompt, brain, priorBriefs] = await Promise.all([
      gatherSignals(read, workspace, live),
      gatherChannels(workspace),
      gatherCalls(read, workspace),
      morningBriefPrompt(workspace.slug),
      brainContext(workspace),
      gatherPriorBriefs(read, workspace),
    ]);

    const inputs = { signals, ...channels, call: call.call, callReason: call.callReason, extraCalls: call.extras, brain: brain.block, priorBriefs };
    const content = briefUserContent(workspace, inputs);
    // Monday's sync reminder and Friday's report reminder are appended here rather than written by the
    // model, so they land in the same place, worded the same way, with the same indent, every week. They
    // are constants; the only thing generating them could add is variation, which is the one thing a
    // standing reminder must not have. Stored and returned with the footer on, because this is the brief
    // people actually read.
    const body_ = briefWithFooter(await writeBrief(systemPrompt, content), workspace.timezone || "America/New_York");

    /*
     * Two messages, not one: a one-line header in the channel, and the brief itself as a reply in its
     * thread. Three page-long briefs a week posted flat is the internal channel turning into a brief
     * archive with the team's actual conversations wedged between them.
     *
     * The header goes first because the reply needs its `ts`. If the header posts and the reply does not,
     * the header is left standing rather than deleted: a header with nothing under it is a visible failure
     * somebody will ask about, and `sendError` names it. Silently tidying it away would hide the fact that
     * a brief was written and never delivered.
     */
    let messageTs = "";
    let briefTs = "";
    let sendError = "";
    if (channelId) {
      try {
        messageTs = await postMessage(channelId, briefHeaderText(workspace));
        briefTs = await postMessage(channelId, body_, messageTs);
      } catch (error) {
        // The brief itself succeeded, so it is returned and stored either way — the send is what failed,
        // and saying which of the two went wrong is the difference between a fixable error and a mystery.
        const detail = error instanceof Error ? error.message : "Slack refused the message.";
        sendError = messageTs ? `The header posted but the brief did not: ${detail}` : detail;
      }
    }
    const posted = Boolean(briefTs);

    /*
     * The tracker step. Deliberately here, after the send, and deliberately in this order.
     *
     * After the send, because the brief is the thing people read and nothing about keeping Airtable
     * tidy is worth delaying or risking it. Everything below is allowed to fail; none of it can make
     * `posted` false or change what went to Slack.
     *
     * Reading the brief that was just written rather than the sources it came from, because a second
     * independent reading of the same fortnight would disagree with the first, and then Slack and
     * Airtable would say different numbers of outstanding things about the same morning. See the note
     * at the top of `tracker-extract.ts`.
     *
     * Runs on a preview too, and that is intentional: a preview is how somebody checks the brief, and
     * checking a step that never runs in the check is not checking it. The tracker is the client's own
     * base either way, so there is no test copy of it to write to instead.
     */
    const tracker: Row = { attempted: false, reason: "", items: 0, result: null };
    const baseId = String((workspace as Row).airtable_base_id ?? "").trim();
    const remaining = startedAt + maxDuration * 1_000 - Date.now();
    if (!baseId) tracker.reason = `${workspace.name} has no Airtable base mapped, so there is no tracker to update.`;
    else if (!isAirtableConfigured()) tracker.reason = "AIRTABLE_API_KEY is not set, so nothing could be written to Airtable.";
    else if (remaining < TRACKER_BUDGET_MS) tracker.reason = "The brief took most of the time budget, so the trackers were left for the next run.";
    else {
      tracker.attempted = true;
      const today = localDayKey(new Date(), workspace.timezone || "America/New_York");
      /*
       * The board is read before the brief is mined, not after, and this order is the whole fix for a
       * tracker that filled up with second copies of its own rows. The extraction is handed the keys
       * already on the board so that an item raised again this morning comes back under the key it is
       * already filed under; reading afterwards left the model inventing a fresh key each time the
       * wording moved, and every re-run added a duplicate instead of updating.
       */
      const board = await readTrackers(baseId);
      // The same roster the brief was told to mention people from. It has to come back the other way or
      // the tracker's Owner column fills up with the `<@U…>` codes the brief is written in.
      const extracted = await extractTrackerItems(body_, signals, {
        timeoutMs: Math.min(TRACKER_MODEL_MS, remaining - 10_000),
        people: [...(channels.internal.people ?? []), ...(channels.external.people ?? [])],
        open: openItems(board.board?.projectRows ?? []),
      });
      tracker.items = extracted.items.length;
      if (extracted.error) tracker.reason = extracted.error;
      /*
       * `null`, not `[]`, when the extraction failed. An empty list is a claim that the brief raised
       * nothing, which starts the clock on removing every row in the tracker; a failure is a claim
       * about nothing at all. Three failed extractions in a row would otherwise quietly empty a
       * client's project tracker, and the campaign half — which needs no model — still runs either way.
       */
      tracker.result = await syncTrackers(baseId, board, signals.campaigns.names, extracted.error ? null : extracted.items, today);
    }

    // `sources` rides along in the same column as the figures because it is the same kind of fact: what
    // the model was given. A brief that reads thinly is then explainable a week later without guessing.
    const sources = {
      internalMessages: channels.internal.messages,
      externalMessages: channels.external.messages,
      extraChannels: (channels.extraChannels ?? []).map((channel) => ({ channelId: channel.channelId, messages: channel.messages })),
      call: call.call ? { title: call.call.title, ageDays: call.call.ageDays, owner: call.call.owner, transcriptChars: call.call.transcript.length } : null,
      extraCalls: call.extras.map((extra) => ({ title: extra.title, ageDays: extra.ageDays, owner: extra.owner, transcriptChars: extra.transcript.length })),
      callReason: call.callReason ?? null,
      // Which folder was read and which documents, not their text: the brain is a repo anybody can open,
      // and a copy of six of its files in a log table is six stale copies.
      brain: { folder: brain.folder, documents: brain.documents, chars: brain.block.length, reason: brain.reason || null },
      // Stored, not just returned: "why did BV003 get marked finished on the 18th" is a question about
      // a write we made into somebody else's base, and it has to be answerable later.
      tracker,
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
      posted,
      sendError,
      tracker,
    });

    await insertBrief(url, key, {
      workspace_id: workspace.id,
      automation: AUTOMATION,
      destination,
      slack_channel_id: channelId || null,
      // The brief's own message, not the header above it — this column is how a stored brief is matched
      // back to the thing people actually read.
      slack_message_ts: briefTs || null,
      body: body_,
      signals: { ...signals, sources },
      status: sendError ? "error" : "success",
      error_text: sendError || null,
    });

    // The roster the brief was written against, as an id→name map. The brief carries people only as
    // `<@U…>` codes; the website has no other way to turn one back into a name, so it rides down with the
    // brief and BriefView resolves the codes on render. Same list the tracker extraction was handed.
    const mentions = Object.fromEntries(
      [...(channels.internal.people ?? []), ...(channels.external.people ?? [])].map((person) => [person.id, person.name]),
    );

    return NextResponse.json({
      ok: !sendError,
      brief: body_,
      mentions,
      signals,
      sources,
      steps,
      posted,
      channelId: channelId || null,
      messageTs: briefTs || null,
      // The header the brief was threaded under, so a caller can tell "nothing posted" apart from "the
      // header went out and the brief did not".
      threadTs: messageTs || null,
      tracker,
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
