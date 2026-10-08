// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The End-of-Week report: the client directory the Slack hub lists, the schedule, and the call that runs
 * one and posts it to the internal channel.
 *
 * ── Why this route runs the Reports pipeline rather than owning its own ───────────────────────────
 * The EOW report *is* the Friday recap the Reports hub already produces — the built-in "Tarsi's EOW Report
 * Template". Rebuilding that here would be a second copy of the generate-then-compose logic that would
 * drift from the one the hub shows. So POST calls `/api/reports/generate` for the week's numbers and
 * `/api/reports/compose` with the Tarsi prompt, then posts the composed email to Slack. The report a
 * client gets on a schedule is byte-for-byte the report an operator would get by clicking Generate.
 *
 * ── Why it is a sibling of the morning brief and not folded into it ───────────────────────────────
 * Same shape — GET lists who is due, POST runs one, PATCH saves the schedule and the per-client opt-in —
 * but a different clock, a different template and a different opt-in flag. A client can be trusted with an
 * EOW report before, after or independently of their morning brief, so the schedule lives under its own
 * `eow_report` key in `rr_slack_automations` and the toggle is its own `eow_report_enabled` column.
 *
 * ── Every attempt is recorded, including the failures ────────────────────────────────────────────
 * A row goes into `rr_slack_briefs` with `automation = 'eow_report'` whether or not Slack accepted the
 * message, because the question the hub answers is "did this client get their recap" and a failed send
 * answers that as firmly as a successful one. The composed text is stored too, so a report can be re-read
 * without another model call.
 */

import { NextResponse } from "next/server";
import {
  alreadySentToday,
  EOW_DEFAULT_SCHEDULE,
  eowReadinessOf,
  isDueNow,
  type BriefSchedule,
} from "../../../lib/morning-brief-schedule";
import { type BriefWorkspace } from "../../../lib/morning-brief";
import { gatherCalls, gatherChannels, gatherLiveFigures, writeBrief } from "../../../lib/morning-brief-run";
import { gatherSignals } from "../../../lib/morning-brief";
import { publicBaseUrl } from "../../../lib/public-url";
import { DEFAULT_EOW_REPORT_PROMPT, eowReportUserContent } from "../../../lib/eow-report-run";
import { brainContext } from "../../../lib/brain-context";
import { truncateForSlack } from "../../../../shared/slack-agent.mjs";
import { postMessage, slackConfigured, slackReadable, SLACK_TOKEN_ENV, SLACK_USER_TOKEN_ENV, userToken } from "../../../lib/slack";
import { slimImages } from "../../../lib/image-refs";
/** Embedded logos and photos become cached /api/img URLs instead of megabytes of base64. */
const slimJson = (body: unknown, init?: ResponseInit) => NextResponse.json(slimImages(body), init);


/**
 * One model call plus the source reads — the same shape as a morning brief. HeyReach can cold-start near
 * its own timeout and the QC Brain is a GitHub read, so this asks for headroom above the brief's sixty
 * seconds rather than the full ceiling the old generate-then-compose flow needed.
 */
export const maxDuration = 240;

type Row = Record<string, unknown>;

/** The channel a report goes to when it is being tried out rather than delivered. */
const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

const AUTOMATION = "eow_report";

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

async function insertReport(url: string, key: string, row: Row): Promise<void> {
  await write(url, key, "rr_slack_briefs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

const asNumberList = (value: unknown): number[] =>
  (Array.isArray(value) ? value : []).map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);

/** The stored schedule, falling back to the EOW default (Fridays 1pm ET) when the row is unwritten. */
function scheduleFrom(rows: unknown): BriefSchedule {
  const row = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
  if (!row) return EOW_DEFAULT_SCHEDULE;
  const days = asNumberList(row.send_days);
  return {
    enabled: Boolean(row.enabled),
    sendDays: days.length ? days : EOW_DEFAULT_SCHEDULE.sendDays,
    sendHour: Number.isFinite(Number(row.send_hour)) ? Number(row.send_hour) : EOW_DEFAULT_SCHEDULE.sendHour,
    sendMinute: Number.isFinite(Number(row.send_minute)) ? Number(row.send_minute) : EOW_DEFAULT_SCHEDULE.sendMinute,
    timezone: String(row.timezone ?? EOW_DEFAULT_SCHEDULE.timezone),
    // A scheduled EOW report goes to the client's internal channel and nowhere else, same as the brief.
    destination: EOW_DEFAULT_SCHEDULE.destination,
  };
}

/**
 * Whether a logged run means the client already had today's post.
 *
 * Any non-preview row used to count, so a run that failed at 8am (status error) or a test post to the
 * test channel marked the client as done and the scheduled post was never retried. Only a successful
 * post to the client's real channel counts. A failure counts for an hour, so a broken client is retried
 * hourly rather than every minute the worker ticks. Test posts never count.
 */
const ERROR_RETRY_MS = 60 * 60_000;
function countsAsSent(row: Row, nowMs: number) {
  const destination = String(row.destination ?? "");
  if (destination !== "internal" && destination !== "external") return false;
  const status = String(row.status ?? "");
  if (status === "success") return true;
  if (status !== "error") return false;
  const at = Date.parse(String(row.created_at ?? ""));
  return Number.isFinite(at) && nowMs - at < ERROR_RETRY_MS;
}

/**
 * The client directory, the schedule, and which clients are due right now.
 *
 * Same four reads as the morning brief minus the Granola keys, because an EOW report reads no call — its
 * two sources are HeyReach's figures and an internal channel to post into, and `eowReadinessOf` checks
 * exactly those.
 */
export async function GET() {
  const credential = credentials();
  if (!credential) return slimJson({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  try {
    const [workspaceRows, keyedRows, reportRows, automationRows] = await Promise.all([
      read("rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,slack_internal_channel_id,slack_external_channel_id,eow_report_enabled,last_successful_poll_at&slug=neq.misc&offboarded_at=is.null&order=name.asc"),
      // A lemlist key counts as an outreach account exactly as a HeyReach key does.
      read("rr_workspaces?select=id&or=(heyreach_api_key_ciphertext.not.is.null,lemlist_api_key.not.is.null,emailbison_workspace_id.not.is.null)"),
      read(`rr_slack_briefs?select=workspace_id,created_at,status,destination,slack_channel_id&automation=eq.${AUTOMATION}&order=created_at.desc&limit=200`).catch(() => []),
      read(`rr_slack_automations?select=automation,enabled,send_days,send_hour,send_minute,timezone,destination&automation=eq.${AUTOMATION}&limit=1`).catch(() => []),
    ]);

    const schedule = scheduleFrom(automationRows);
    const withHeyreachKey = new Set((Array.isArray(keyedRows) ? (keyedRows as Row[]) : []).map((row) => String(row.id ?? "")));

    const reports = Array.isArray(reportRows) ? (reportRows as Row[]) : [];
    const latest = new Map<string, Row>();
    const latestSent = new Map<string, Row>();
    const nowMs = Date.now();
    for (const report of reports) {
      const id = String(report.workspace_id ?? "");
      if (!id) continue;
      if (!latest.has(id)) latest.set(id, report);
      if (!latestSent.has(id) && countsAsSent(report, nowMs)) latestSent.set(id, report);
    }

    const now = new Date();
    const due = isDueNow(schedule, now);

    const workspaces = (Array.isArray(workspaceRows) ? (workspaceRows as Row[]) : []).map((workspace) => {
      const id = String(workspace.id ?? "");
      const last = latest.get(id);
      const sent = latestSent.get(id);
      const internalChannelId = String(workspace.slack_internal_channel_id ?? "");
      const externalChannelId = String(workspace.slack_external_channel_id ?? "");
      const enabled = Boolean(workspace.eow_report_enabled);
      const readiness = eowReadinessOf({
        heyreachKeyConfigured: withHeyreachKey.has(id),
        lastSuccessfulPollAt: workspace.last_successful_poll_at ? String(workspace.last_successful_poll_at) : null,
        internalChannelId,
        externalChannelId,
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
        eowReportEnabled: enabled,
        readiness,
        sentToday,
        lastBriefAt: last ? String(last.created_at ?? "") : null,
        lastBriefStatus: last ? String(last.status ?? "") : null,
        lastBriefDestination: last ? String(last.destination ?? "") : null,
        // The worker reads this rather than recomputing it. Readiness is required as well as the toggle.
        dueNow: due && enabled && readiness.ready && !sentToday,
      };
    });

    return slimJson({
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
      schedule,
      scheduleDueNow: due,
      workspaces,
      due: workspaces.filter((workspace) => workspace.dueNow).map((workspace) => workspace.slug),
    });
  } catch (error) {
    return slimJson({ error: error instanceof Error ? error.message : "Could not load the client list." }, { status: 502 });
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
      const destination = "internal";
      if (input.enabled && !days.length) return NextResponse.json({ error: "Pick at least one day, or switch the automation off." }, { status: 400 });
      const response = await write(url, key, "rr_slack_automations", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          automation: AUTOMATION,
          enabled: Boolean(input.enabled),
          send_days: days.length ? days : EOW_DEFAULT_SCHEDULE.sendDays,
          send_hour: hour,
          send_minute: minute,
          timezone: String(input.timezone ?? EOW_DEFAULT_SCHEDULE.timezone),
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
        body: JSON.stringify({ eow_report_enabled: Boolean(body.enabled) }),
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

/** "8/21" in the client's own zone — the date the report is being sent, for the channel header. */
function shortDate(timeZone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-US", { month: "numeric", day: "numeric" }).format(now);
  }
}

/** The one-line header the report threads under, e.g. "Bluevia 8/21 EOW Report". */
function reportHeader(clientName: string, timeZone: string): string {
  return `*${clientName} ${shortDate(timeZone)} EOW Report*`;
}

/**
 * The email as Slack blocks: the email itself in a quote (so it reads as "the thing to send" and copies
 * cleanly on its own), a grey line naming what it was written from, and a button into QC Command's Reports
 * page with this client and the same template open, to edit or regenerate it there.
 */
function emailBlocks(body: string, slug: string, read: { live: boolean; platform?: string; internal: number | null; external: number | null; call: string | null }): unknown[] {
  // Rich text, not mrkdwn sections: Slack folds any section past about five lines behind "Show more", which
  // hid the recap. Rich text shows in full and still has real bullets and bold.
  const inline = (line: string) => line.split(/(\*[^*\n]+\*)/).filter(Boolean).map((part) =>
    /^\*[^*]+\*$/.test(part) ? { type: "text", text: part.slice(1, -1), style: { bold: true } } : { type: "text", text: part });
  const elements: unknown[] = [];
  let lines: string[] = [];
  let bullets: string[] = [];
  // A blank line in the email (and the end of a list) becomes a visible gap; a heading stays tight to its list.
  let gapBefore = false;
  const flushLines = (gapAfter = false) => {
    if (lines.length) {
      const body = lines.flatMap((l, n) => [...inline(l), ...(n < lines.length - 1 ? [{ type: "text", text: "\n" }] : [])]);
      // Slack drops a trailing newline in a rich text section but keeps a leading one, so a gap after this
      // paragraph is written as a gap before the next.
      elements.push({ type: "rich_text_section", elements: [...(gapBefore ? [{ type: "text", text: "\n" }] : []), ...body] });
      gapBefore = gapAfter;
    }
    lines = [];
  };
  const flushBullets = () => { if (bullets.length) { elements.push({ type: "rich_text_list", style: "bullet", elements: bullets.map((b) => ({ type: "rich_text_section", elements: inline(b) })) }); gapBefore = true; } bullets = []; };
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-•]\s+(.*)$/);
    if (bullet && !/^-\s*QC Growth$/.test(line.trim())) { flushLines(); bullets.push(bullet[1]); continue; }
    flushBullets();
    if (!line.trim()) { if (lines.length) lines.push(""); continue; }
    if (lines.length && lines[lines.length - 1] === "") { lines.pop(); flushLines(true); }
    // Headings (a wholly bold line) always start a new paragraph with a gap, and the subject line always
    // stands apart, whether or not the model left blank lines around them.
    const heading = /^\*[^*]+\*$/.test(line.trim());
    if (heading && lines.length) flushLines(true);
    else if (lines.length === 1 && /^\*Subject/i.test(lines[0])) flushLines(true);
    lines.push(line);
  }
  flushLines(); flushBullets();
  const sources = [
    read.live ? `${read.platform || "HeyReach"} live` : `${read.platform || "HeyReach"} (stored figures)`,
    read.internal === null ? "" : `internal channel (${read.internal} msgs)`,
    read.external === null ? "" : `external channel (${read.external} msgs)`,
    read.call ? `Granola: ${read.call}` : "no call this week",
  ].filter(Boolean).join("  ·  ");
  const base = publicBaseUrl() || "https://www.replyradar.dev";
  return [
    { type: "rich_text", elements },
    { type: "context", elements: [{ type: "mrkdwn", text: `Written from: ${sources}` }] },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Edit in Reports" }, url: `${base}/reports?client=${encodeURIComponent(slug)}&template=weekly-recap`, action_id: "eow_edit" }] },
  ];
}

/** The EOW report reads the last week of Slack and only a call from this week. */
const EOW_WINDOW_DAYS = 7;

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
    destination = body.destination === "test" || body.destination === "internal" ? body.destination : "preview";
    if (!slug) return NextResponse.json({ error: "No client was named." }, { status: 400 });

    // Two selects, because the extra-source columns are an additive migration and PostgREST fails the whole
    // read over one unknown column. A database without the migration still writes reports; it just writes
    // them from the two named channels and the one call. Same columns the morning brief reads.
    const columns = "id,name,slug,timezone,client_brief,brain_folder,slack_internal_channel_id,slack_external_channel_id,granola_title_match,heyreach_api_key_ciphertext,lemlist_api_key";
    const rows = await read(`rr_workspaces?select=${columns},offboarded_at,slack_extra_channel_ids,granola_extra_title_matches&slug=eq.${encodeURIComponent(slug)}&limit=1`)
      .catch(() => read(`rr_workspaces?select=${columns}&slug=eq.${encodeURIComponent(slug)}&limit=1`));
    const found = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
    if (!found) return NextResponse.json({ error: "That client does not exist." }, { status: 404 });
    // Offboarded clients get nothing posted to Slack, whoever asks: the scheduler's lists already leave
    // them out, and this stops a manual send, a queued recap or a scheduler holding an older list.
    if (found.offboarded_at && destination !== "preview") {
      return NextResponse.json({ error: `${String(found.name ?? slug)} is offboarded, so nothing is posted to Slack for them. Restore the client in Configuration to resume.`, offboarded: true }, { status: 409 });
    }
    workspace = found as BriefWorkspace;
    const clientName = String(workspace.name ?? "");
    const timeZone = String(workspace.timezone ?? "") || "America/New_York";

    // Worked out before the model call, so a report that has nowhere to go costs nothing to refuse.
    let channelId = "";
    if (destination === "test") {
      channelId = (process.env[TEST_CHANNEL_ENV] ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${TEST_CHANNEL_ENV} is not set, so there is no test channel to post to.` }, { status: 400 });
    }
    if (destination === "internal") {
      channelId = String(workspace.slack_internal_channel_id ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${clientName} has no internal channel id. Add one on their configuration page.` }, { status: 400 });
    }
    if (channelId && !slackConfigured()) {
      return NextResponse.json({ error: `${SLACK_TOKEN_ENV} is not set, so nothing can be posted to Slack.` }, { status: 400 });
    }

    /*
     * Every source, the way the morning brief reads them. HeyReach is asked first and on its own, because
     * its answer decides whether the stored figures are read at all: given a live one, `gatherSignals` does
     * not touch the stored tables, and given a failure it reads them and the report says the numbers are a
     * copy. The rest run together — channels, the call and the QC Brain — none of which throws, so a missing
     * call or an unreachable brain is a thinner report rather than a failed one.
     */
    const live = await gatherLiveFigures(String((found as Row).heyreach_api_key_ciphertext ?? ""), String((found as Row).lemlist_api_key ?? ""));
    const [signals, channels, call, brain] = await Promise.all([
      gatherSignals(read, workspace, live),
      gatherChannels(workspace, EOW_WINDOW_DAYS),
      gatherCalls(read, workspace),
      brainContext(workspace),
    ]);
    // A weekly report uses this week's call only; an older one would be reported as this week's news.
    const thisWeeksCall = call.call && (call.call.ageDays === null || call.call.ageDays <= EOW_WINDOW_DAYS) ? call.call : null;
    const callReason = call.call && !thisWeeksCall
      ? `There was no call with this client this week (the last one was ${call.call.ageDays} days ago). Do not report anything from it as this week's.`
      : call.callReason;

    const inputs = { signals, ...channels, call: thisWeeksCall, callReason, brain: brain.block };
    const content = eowReportUserContent(workspace, inputs);
    const slackBody = truncateForSlack(await writeBrief(DEFAULT_EOW_REPORT_PROMPT, content));
    const header = reportHeader(clientName, timeZone);

    // Two messages: a one-line header in the channel, the report itself as a reply in its thread. Same
    // reasoning as the morning brief — a page-long recap posted flat buries the channel.
    let messageTs = "";
    let reportTs = "";
    let sendError = "";
    if (channelId) {
      try {
        messageTs = await postMessage(channelId, header);
        reportTs = await postMessage(channelId, slackBody, messageTs, emailBlocks(slackBody, String(workspace.slug ?? ""), {
          live: live.available,
          platform: live.source,
          internal: channels.internal.channelId ? channels.internal.messages : null,
          external: channels.external.channelId ? channels.external.messages : null,
          call: thisWeeksCall ? `${thisWeeksCall.title}${thisWeeksCall.ageDays !== null ? ` (${thisWeeksCall.ageDays === 0 ? "today" : `${thisWeeksCall.ageDays}d ago`})` : ""}` : null,
        }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Slack refused the message.";
        sendError = messageTs ? `The header posted but the report did not: ${detail}` : detail;
      }
    }
    const posted = Boolean(reportTs);

    // What the model was given, figures only. The transcript and channels are not stored — a copy of every
    // client call in a log table is exactly what nobody wants — but which sources were thin is recorded.
    const sources = {
      internalMessages: channels.internal.messages,
      externalMessages: channels.external.messages,
      call: call.call ? { title: call.call.title, ageDays: call.call.ageDays, owner: call.call.owner, transcriptChars: call.call.transcript.length } : null,
      callReason: call.callReason ?? null,
      brain: { folder: brain.folder, documents: brain.documents, chars: brain.block.length, reason: brain.reason || null },
    };

    await insertReport(url, key, {
      workspace_id: workspace.id,
      automation: AUTOMATION,
      destination,
      slack_channel_id: channelId || null,
      slack_message_ts: reportTs || null,
      body: slackBody,
      signals: { ...signals, sources },
      status: sendError ? "error" : "success",
      error_text: sendError || null,
    });

    return NextResponse.json({
      ok: !sendError,
      // `brief` rather than `report` so the Slack hub renders it through the same BriefView the morning
      // brief uses. It is the exact text that posted into the thread. No mention map: this report is
      // client-facing and carries no `<@U…>` codes to resolve.
      brief: slackBody,
      signals,
      sources,
      posted,
      channelId: channelId || null,
      messageTs: reportTs || null,
      threadTs: messageTs || null,
      channelNotes: [channels.internal.error, channels.external.error, ...call.errors].filter(Boolean),
      error: sendError || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report could not be written.";
    if (workspace) {
      await insertReport(url, key, {
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
