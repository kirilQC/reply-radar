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
import { BUILT_IN_TEMPLATES } from "../../../lib/report-templates";
import { postMessage, slackConfigured, slackReadable, SLACK_TOKEN_ENV, SLACK_USER_TOKEN_ENV, userToken } from "../../../lib/slack";
import { toSlackText, truncateForSlack } from "../../../../shared/slack-agent.mjs";

/**
 * Generate, then compose, then two Slack posts — heavier than a morning brief, which is one model call.
 * The generate step scans a week of messages and asks HeyReach for the funnel, and compose is a second
 * model call, so this asks for the full ceiling rather than the brief's sixty seconds.
 */
export const maxDuration = 120;

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

/** The channel a report goes to when it is being tried out rather than delivered. */
const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

const AUTOMATION = "eow_report";

/** The built-in Tarsi template this automation runs. Its prompt and period are the report's definition. */
const EOW_TEMPLATE = BUILT_IN_TEMPLATES.find((template) => template.id === "weekly-recap");

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
 * The client directory, the schedule, and which clients are due right now.
 *
 * Same four reads as the morning brief minus the Granola keys, because an EOW report reads no call — its
 * two sources are HeyReach's figures and an internal channel to post into, and `eowReadinessOf` checks
 * exactly those.
 */
export async function GET() {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  try {
    const [workspaceRows, keyedRows, reportRows, automationRows] = await Promise.all([
      read("rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,slack_internal_channel_id,slack_external_channel_id,eow_report_enabled,last_successful_poll_at&order=name.asc"),
      read("rr_workspaces?select=id&heyreach_api_key_ciphertext=not.is.null"),
      read(`rr_slack_briefs?select=workspace_id,created_at,status,destination,slack_channel_id&automation=eq.${AUTOMATION}&order=created_at.desc&limit=200`).catch(() => []),
      read(`rr_slack_automations?select=automation,enabled,send_days,send_hour,send_minute,timezone,destination&automation=eq.${AUTOMATION}&limit=1`).catch(() => []),
    ]);

    const schedule = scheduleFrom(automationRows);
    const withHeyreachKey = new Set((Array.isArray(keyedRows) ? (keyedRows as Row[]) : []).map((row) => String(row.id ?? "")));

    const reports = Array.isArray(reportRows) ? (reportRows as Row[]) : [];
    const latest = new Map<string, Row>();
    const latestSent = new Map<string, Row>();
    for (const report of reports) {
      const id = String(report.workspace_id ?? "");
      if (!id) continue;
      if (!latest.has(id)) latest.set(id, report);
      if (!latestSent.has(id) && String(report.destination ?? "") !== "preview") latestSent.set(id, report);
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

/**
 * Splits the composed email into the one-line header Slack threads under and the body of the report.
 *
 * The compose route puts the subject on its own first block as `Subject: …`. That line makes a natural
 * channel header — it is written to be scanned — so it is lifted out, and everything after it becomes the
 * threaded reply. A report with no subject line falls back to a named header so the thread still reads as
 * this client's EOW recap rather than an anonymous wall of text.
 */
function splitReport(message: string, clientName: string): { header: string; body: string } {
  const blocks = message.split("\n\n");
  const first = (blocks[0] ?? "").trim();
  const subjectMatch = first.match(/^Subject:\s*(.+)$/i);
  if (subjectMatch) {
    return { header: `*${subjectMatch[1].trim()}*  :calendar:`, body: blocks.slice(1).join("\n\n").trim() };
  }
  return { header: `*${clientName} — End-of-Week recap*  :calendar:`, body: message.trim() };
}

export async function POST(request: Request) {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  if (!EOW_TEMPLATE) return NextResponse.json({ error: "The EOW report template is missing." }, { status: 500 });
  const { url, key } = credential;
  const read = reader(url, key);

  let workspaceId = "";
  let destination = "preview";

  try {
    const body = (await request.json().catch(() => ({}))) as Row;
    const slug = typeof body.workspace === "string" ? body.workspace.trim() : "";
    destination = body.destination === "test" || body.destination === "internal" ? body.destination : "preview";
    if (!slug) return NextResponse.json({ error: "No client was named." }, { status: 400 });

    const rows = await read(`rr_workspaces?select=id,name,slug,timezone,slack_internal_channel_id&slug=eq.${encodeURIComponent(slug)}&limit=1`);
    const workspace = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
    if (!workspace) return NextResponse.json({ error: "That client does not exist." }, { status: 404 });
    workspaceId = String(workspace.id ?? "");
    const clientName = String(workspace.name ?? "");
    const timeZone = String(workspace.timezone ?? "") || "America/New_York";

    // Worked out before the model calls, so a report that has nowhere to go costs nothing to refuse.
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

    const origin = new URL(request.url).origin;

    // The week's numbers, computed by the same endpoint the Reports hub uses.
    const generateResponse = await fetch(`${origin}/api/reports/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceSlug: slug, period: EOW_TEMPLATE.defaultPeriod, timeZone }),
      cache: "no-store",
    });
    const generated = (await generateResponse.json().catch(() => ({}))) as Json;
    if (!generateResponse.ok || !generated.ok) {
      throw new Error(String(generated.error ?? "The report figures could not be generated."));
    }
    const clients = Array.isArray(generated.clients) ? generated.clients : [];
    if (!clients.length) throw new Error("The report figures came back empty.");

    // The Tarsi prompt turned into the recap email, by the same endpoint the Reports hub uses.
    const composeResponse = await fetch(`${origin}/api/reports/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: EOW_TEMPLATE.prompt,
        templateId: EOW_TEMPLATE.id,
        clients,
        periodLabel: String(generated.periodLabel ?? "this week"),
      }),
      cache: "no-store",
    });
    const composed = (await composeResponse.json().catch(() => ({}))) as Json;
    if (!composeResponse.ok || !composed.ok) {
      throw new Error(String(composed.error ?? "The report could not be written."));
    }
    const email = String(composed.message ?? "").trim();
    if (!email) throw new Error("The composed report was empty.");

    const { header, body: reportBody } = splitReport(email, clientName);
    const slackBody = truncateForSlack(toSlackText(reportBody));

    // Two messages: a one-line header in the channel, the report itself as a reply in its thread. Same
    // reasoning as the morning brief — a page-long recap posted flat buries the channel.
    let messageTs = "";
    let reportTs = "";
    let sendError = "";
    if (channelId) {
      try {
        messageTs = await postMessage(channelId, header);
        reportTs = await postMessage(channelId, slackBody, messageTs);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Slack refused the message.";
        sendError = messageTs ? `The header posted but the report did not: ${detail}` : detail;
      }
    }
    const posted = Boolean(reportTs);

    await insertReport(url, key, {
      workspace_id: workspaceId,
      automation: AUTOMATION,
      destination,
      slack_channel_id: channelId || null,
      slack_message_ts: reportTs || null,
      body: email,
      signals: { periodLabel: String(generated.periodLabel ?? ""), templateId: EOW_TEMPLATE.id, model: composed.model ?? null },
      status: sendError ? "error" : "success",
      error_text: sendError || null,
    });

    return NextResponse.json({
      ok: !sendError,
      // `brief` rather than `report` so the Slack hub renders it through the same BriefView the morning
      // brief uses. It is the Slack-rendered body — the exact text that posted into the thread.
      brief: slackBody,
      headline: composed.headline ?? null,
      posted,
      channelId: channelId || null,
      messageTs: reportTs || null,
      threadTs: messageTs || null,
      periodLabel: String(generated.periodLabel ?? ""),
      error: sendError || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The report could not be written.";
    if (workspaceId) {
      await insertReport(url, key, {
        workspace_id: workspaceId,
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
