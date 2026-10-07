// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Booking alerts, the side that talks to Calendly, Clay, Slack and HubSpot. Replaces the per-client
 * "Calendar > Clay > Spark > Slack > Sheets" Zaps. Parsing and layout are in shared/bookings.mjs.
 *
 * ── The order ───────────────────────────────────────────────────────────────────────────────────
 *   1. Calendly (or cal.com) posts a booking. It is routed to a client by event-type name, stored in
 *      rr_meetings, and matched against leads we contacted (LinkedIn + campaign, when we know them).
 *   2. The booking is added as a row to the one shared Clay table. Clay finds the LinkedIn from name,
 *      company and title, enriches person and company, and its last column posts the result back to
 *      /api/webhooks/clay/booking.
 *   3. That callback runs the client's steps: the Slack card with LEAD INFO and TLDR in the thread, a
 *      HubSpot deal, any extra webhooks. A TLDR Clay did not write is written here, from the client brief
 *      and the conversation that led to the booking.
 *   If Clay never answers, the worker's sweep runs the steps anyway after the wait (default 15 minutes),
 *   with QC's own enrichment, so a booking is never silently dropped.
 *
 * ── State ───────────────────────────────────────────────────────────────────────────────────────
 * Each meeting's `booking` column records where it is: stage (new, enriching, ready, done, failed,
 * skipped), the Clay round trip, the TLDR, and each step's result. A step that finished is never run
 * again, so a retry after a half-done run only does what is left. Delivery is claimed in rr_app_config
 * (the same atomic insert reply alerts use) so the callback and the sweep cannot both post a card.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildBookingCard,
  buildInfoThread,
  buildTldrThread,
  changeNote,
  clayRow,
  clean,
  formatMeetingTime,
  fromClay,
  hasTldr,
  normalizeSteps,
  routeBooking,
} from "../../shared/bookings.mjs";
import { stripDashes } from "../../shared/no-dashes.mjs";
import { resolveModel, temperatureField } from "../../shared/anthropic-model.mjs";
import { campaignFromLead, enrichMeeting, findLeadForMeeting, getMeetingConversation } from "./meetings";
import { postMessage, slackConfigured, updateMessage } from "./slack";
import { publicBaseUrl } from "./public-url";
import { writeAuditEvent } from "./audit-log";

type Row = Record<string, unknown>;
export type Config = { url: string; key: string };
type Tldr = { leadSummary?: string; leadCallFocus?: string; companySummary?: string; companyCallFocus?: string };
export type Step = { id: string; type: string; enabled: boolean; url?: string; label?: string; stage?: string; pipeline?: string; owner?: string; campaignProperty?: string };
type StepResult = Row & { done_at?: string; error?: string; failed_at?: string; attempts?: number };
type Booking = {
  stage?: string;
  source?: string;
  received_at?: string;
  clay?: { sent_at?: string; received_at?: string; error?: string; timed_out?: boolean };
  tldr?: Tldr;
  tldr_source?: string;
  steps?: Record<string, StepResult>;
  error?: string;
  next_try_at?: string;
  changes?: Array<{ at: string; kind: string; from?: string }>;
};
export type CalendlyConnection = {
  email: string;
  name: string;
  user_uri: string;
  org_uri: string;
  scope: string;
  subscription_uri: string;
  signing_key: string;
  url: string;
  connected_at: string;
};
export type BookingSettings = {
  clay_webhook_url?: string;
  clay_auth_token?: string;
  clay_wait_minutes?: number;
  callback_secret?: string;
  base_url?: string;
  calendly_token?: string;
  calendly?: CalendlyConnection | null;
  last_clay_callback?: { at: string; meeting_id: string; test: boolean; fields: string[] } | null;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;
const now = () => new Date().toISOString();

const SETTINGS_KEY = "booking_settings";
/** How long Clay gets before the steps run without it. The Zaps waited about five minutes in total. */
export const DEFAULT_CLAY_WAIT_MINUTES = 15;
/** A delivery claim older than this belongs to a run that died. */
const CLAIM_STALE_MS = 5 * 60 * 1000;
/** A step that failed this many times stops being retried; the booking shows it as failed. */
const MAX_ATTEMPTS = 3;
const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";
const WORKSPACE_COLUMNS = "id,name,slug,logo_url,offboarded_at,booking_config,calendly_token,calendly_subscription,calcom_secret,crm_provider,crm_api_key_ciphertext,client_brief";

export function supabaseConfig(): Config | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

async function rest(config: Config, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  }).catch(() => null);
  if (!response) return { ok: false, status: 0, data: null };
  const body = await response.text().catch(() => "");
  let data: unknown = body;
  try { data = body ? JSON.parse(body) : null; } catch { /* keep the text */ }
  return { ok: response.ok, status: response.status, data };
}

async function rows(config: Config, path: string): Promise<Row[]> {
  const result = await rest(config, path);
  if (!result.ok) throw new Error(`Supabase ${path.split("?")[0]} ${result.status}: ${String(typeof result.data === "string" ? result.data : JSON.stringify(result.data)).slice(0, 200)}`);
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────

export async function readSettings(config: Config): Promise<BookingSettings> {
  const result = await rest(config, `rr_app_config?select=value&key=eq.${SETTINGS_KEY}&limit=1`);
  const row = result.ok && Array.isArray(result.data) ? (result.data[0] as Row | undefined) : undefined;
  return row ? (object(row.value) as BookingSettings) : {};
}

/** Merges `patch` into the stored settings (re-read first, so two saves of different fields both land). */
export async function writeSettings(config: Config, patch: Partial<BookingSettings>): Promise<BookingSettings> {
  const value = { ...(await readSettings(config)), ...patch };
  const result = await rest(config, "rr_app_config?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key: SETTINGS_KEY, value, updated_at: now() }),
  });
  if (!result.ok) throw new Error(`Could not save the booking settings (${result.status}).`);
  return value;
}

/** The secret on the Clay callback URL, made on first use. */
export async function ensureCallbackSecret(config: Config, settings: BookingSettings, request?: Request): Promise<BookingSettings> {
  const patch: Partial<BookingSettings> = {};
  if (!settings.callback_secret) patch.callback_secret = randomBytes(18).toString("base64url");
  // Remembered so the sweep, which has no request to read a host from, builds the same URL.
  if (request) {
    const base = publicBaseUrl(request);
    if (base && base !== settings.base_url) patch.base_url = base;
  }
  return Object.keys(patch).length ? writeSettings(config, patch) : settings;
}

export const baseUrl = (settings: BookingSettings) => settings.base_url || publicBaseUrl();
export const clayCallbackUrl = (settings: BookingSettings) =>
  settings.callback_secret ? `${baseUrl(settings)}/api/webhooks/clay/booking?secret=${settings.callback_secret}` : "";

export function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(String(provided ?? ""));
  const b = Buffer.from(String(expected ?? ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** A client's booking settings, with defaults. */
export function clientConfig(workspace: Row) {
  const config = object(workspace.booking_config);
  return {
    enabled: config.enabled === true,
    enabledAt: text(config.enabled_at) || null,
    eventFilter: text(config.event_filter),
    channel: text(config.channel),
    botName: text(config.bot_name),
    steps: normalizeSteps(config.steps) as Step[],
  };
}

const bookingOf = (row: Row): Booking => object(row.booking) as Booking;

async function loadWorkspace(config: Config, id: string): Promise<Row | null> {
  if (!id) return null;
  return (await rows(config, `rr_workspaces?select=${WORKSPACE_COLUMNS}&id=eq.${enc(id)}&limit=1`))[0] ?? null;
}

async function loadMeeting(config: Config, id: string): Promise<Row | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return (await rows(config, `rr_meetings?select=*&id=eq.${enc(id)}&limit=1`))[0] ?? null;
}

async function patchMeeting(config: Config, id: string, patch: Row): Promise<void> {
  const result = await rest(config, `rr_meetings?id=eq.${enc(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!result.ok) throw new Error(`Could not update the meeting (${result.status}).`);
}

/** Writes `booking`, merged over what is stored now so a concurrent Clay callback is not undone. */
async function saveBooking(config: Config, id: string, patch: Booking): Promise<Booking> {
  const current = await loadMeeting(config, id);
  const merged: Booking = { ...bookingOf(current ?? {}), ...patch };
  if (patch.steps) merged.steps = { ...(bookingOf(current ?? {}).steps ?? {}), ...patch.steps };
  if (patch.clay) merged.clay = { ...(bookingOf(current ?? {}).clay ?? {}), ...patch.clay };
  await patchMeeting(config, id, { booking: merged });
  return merged;
}

// ── Claims ────────────────────────────────────────────────────────────────────────────────────────

/** One delivery at a time per meeting. Returns a token to release with, or null when someone else holds it. */
async function claim(config: Config, key: string): Promise<string | null> {
  const token = randomUUID();
  const value = { status: "claimed", token, at: now() };
  const inserted = await rest(config, "rr_app_config", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ key, value }) });
  if (inserted.ok) return token;
  if (inserted.status !== 409) return null;
  const existing = await rest(config, `rr_app_config?select=value&key=eq.${enc(key)}&limit=1`);
  const held = object(Array.isArray(existing.data) ? object(existing.data[0]).value : null);
  if (Date.now() - Date.parse(text(held.at)) < CLAIM_STALE_MS) return null;
  const swapped = await rest(config, `rr_app_config?key=eq.${enc(key)}&value->>token=eq.${enc(text(held.token))}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ value, updated_at: now() }),
  });
  return swapped.ok && Array.isArray(swapped.data) && swapped.data.length === 1 ? token : null;
}

async function release(config: Config, key: string, token: string): Promise<void> {
  await rest(config, `rr_app_config?key=eq.${enc(key)}&value->>token=eq.${enc(token)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

// ── Intake ────────────────────────────────────────────────────────────────────────────────────────

export type Parsed = {
  kind: string;
  eventName: string;
  externalId: string;
  previousId: string;
  fields: Row;
};
export type IntakeResult = { ok: boolean; note: string; meetingId?: string; client?: string; run?: () => Promise<void> };

/**
 * The client a booking belongs to. A client with its own calendar connection gets its bookings on its own
 * URL (`workspaceId`); the shared QC calendar is routed by event-type name among every active client that
 * does not have its own connection. Routing looks at clients that are switched off too, so a booking for a
 * client that is off is dropped rather than handed to the next closest name.
 */
async function routeIntake(config: Config, parsed: Parsed, workspaceId?: string): Promise<{ workspace: Row | null; note: string }> {
  if (workspaceId) {
    const workspace = await loadWorkspace(config, workspaceId);
    if (!workspace) return { workspace: null, note: "Unknown client." };
    const filter = clientConfig(workspace).eventFilter;
    if (filter && !routeBooking(parsed.eventName, [{ id: text(workspace.id), name: text(workspace.name), filter }])) {
      return { workspace: null, note: `"${parsed.eventName}" does not match this client's event filter.` };
    }
    return { workspace, note: "" };
  }
  const everyone = await rows(config, `rr_workspaces?select=${WORKSPACE_COLUMNS}&slug=neq.misc&offboarded_at=is.null`);
  const shared = everyone.filter((workspace) => !text(object(workspace.calendly_subscription).subscription_uri));
  const match = routeBooking(parsed.eventName, shared.map((workspace) => ({ id: text(workspace.id), name: text(workspace.name), filter: clientConfig(workspace).eventFilter })));
  if (!match) return { workspace: null, note: `No single client matches the event "${parsed.eventName}".` };
  return { workspace: shared.find((workspace) => text(workspace.id) === match.id) ?? null, note: "" };
}

async function meetingByExternalId(config: Config, workspaceId: string, externalId: string): Promise<Row | null> {
  if (!externalId) return null;
  return (await rows(config, `rr_meetings?select=*&workspace_id=eq.${enc(workspaceId)}&external_id=eq.${enc(externalId)}&limit=1`))[0] ?? null;
}

/** Edits the card and adds a note to its thread, for a booking moved or canceled after it was posted. */
async function noteChange(config: Config, meeting: Row, kind: "rescheduled" | "canceled", previousWhen: string): Promise<void> {
  const slack = object(bookingOf(meeting).steps?.slack);
  const channel = text(slack.channel);
  const ts = text(slack.ts);
  if (!channel || !ts || !slackConfigured()) return;
  const card = buildBookingCard(meeting, { rescheduledFrom: kind === "rescheduled" ? previousWhen : "" });
  await updateMessage(channel, ts, card.text, card.blocks).catch(() => undefined);
  await postMessage(channel, changeNote(meeting, kind, previousWhen), ts).catch(() => "");
}

/**
 * A parsed Calendly / cal.com event: store it and say what to run after the webhook has answered.
 * Calendly retries a webhook that does not get a 2xx, so every handled outcome here is `ok`, including
 * "not for any client"; only a failure to store is not.
 */
export async function intakeBooking(config: Config, parsed: Parsed, source: string, raw: unknown, workspaceId?: string): Promise<IntakeResult> {
  if (parsed.kind === "ignored") return { ok: true, note: "Nothing to do for this event." };
  const { workspace, note } = await routeIntake(config, parsed, workspaceId);
  if (!workspace) return { ok: true, note };
  const client = text(workspace.name);
  const settings = clientConfig(workspace);
  if (!settings.enabled || workspace.offboarded_at) return { ok: true, note: `Booking alerts are off for ${client}.`, client };
  const wid = text(workspace.id);

  if (parsed.kind === "canceled") {
    const meeting = await meetingByExternalId(config, wid, parsed.externalId);
    if (!meeting) return { ok: true, note: "A cancel for a booking QC never saw.", client };
    await patchMeeting(config, text(meeting.id), { status: "canceled" });
    const updated = { ...meeting, status: "canceled" };
    await saveBooking(config, text(meeting.id), { changes: [...(bookingOf(meeting).changes ?? []), { at: now(), kind: "canceled" }] });
    return { ok: true, note: "Marked canceled.", client, meetingId: text(meeting.id), run: () => noteChange(config, updated, "canceled", "") };
  }

  // A reschedule moves the meeting it replaces, so it keeps its card, its thread and its HubSpot deal.
  if (parsed.previousId) {
    const previous = await meetingByExternalId(config, wid, parsed.previousId);
    if (previous) {
      const previousWhen = clean(previous.meeting_at) ? formatMeetingTime(previous.meeting_at) : clean(previous.when_text);
      const patch = { external_id: parsed.externalId || previous.external_id, meeting_at: parsed.fields.meeting_at, when_text: parsed.fields.when_text, status: "rescheduled" };
      await patchMeeting(config, text(previous.id), patch);
      await saveBooking(config, text(previous.id), { changes: [...(bookingOf(previous).changes ?? []), { at: now(), kind: "rescheduled", from: previousWhen }] });
      const updated = { ...previous, ...patch };
      return { ok: true, note: "Rescheduled.", client, meetingId: text(previous.id), run: () => noteChange(config, updated, "rescheduled", previousWhen) };
    }
  }

  // Calendly sends a webhook more than once when an answer is slow; the same booking is stored once.
  const existing = await meetingByExternalId(config, wid, parsed.externalId);
  if (existing) return { ok: true, note: "Already received.", client, meetingId: text(existing.id) };

  const body: Row = { workspace_id: wid, source, raw: object(raw), booking: { stage: "new", source, received_at: now() } };
  for (const [column, value] of Object.entries(parsed.fields)) {
    if (value !== null && value !== undefined && text(value) !== "") body[column] = value;
  }
  if (parsed.externalId) body.external_id = parsed.externalId;
  const created = await rest(config, "rr_meetings", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!created.ok) return { ok: false, note: `Could not save the booking (${created.status}).`, client };
  const meeting = (Array.isArray(created.data) ? created.data[0] : null) as Row | null;
  if (!meeting) return { ok: false, note: "The booking was not saved.", client };
  const meetingId = text(meeting.id);
  return { ok: true, note: "Saved.", client, meetingId, run: () => startBooking(config, meetingId) };
}

/** Name + company against the leads we contacted, before Clay: a known lead brings its LinkedIn and campaign. */
async function matchKnownLead(config: Config, meeting: Row): Promise<Row> {
  const lead = await findLeadForMeeting(config.url, config.key, text(meeting.workspace_id), {
    linkedin: text(meeting.invitee_linkedin),
    email: text(meeting.invitee_email),
    name: text(meeting.invitee_name),
    company: text(meeting.company_name),
  }).catch(() => null);
  if (!lead) return {};
  const patch: Row = {};
  if (!clean(meeting.invitee_linkedin) && text(lead.linkedin_profile_url)) patch.invitee_linkedin = text(lead.linkedin_profile_url);
  const campaign = campaignFromLead(lead);
  if (!clean(meeting.campaign) && campaign) patch.campaign = campaign;
  return patch;
}

/** Step 2: hand the booking to Clay, or straight to the steps when no Clay table is set up. */
export async function startBooking(config: Config, meetingId: string): Promise<void> {
  let meeting = await loadMeeting(config, meetingId);
  if (!meeting) return;
  const known = await matchKnownLead(config, meeting);
  if (Object.keys(known).length) {
    await patchMeeting(config, meetingId, known);
    meeting = { ...meeting, ...known };
  }
  const settings = await ensureCallbackSecret(config, await readSettings(config));
  if (!text(settings.clay_webhook_url)) {
    await saveBooking(config, meetingId, { stage: "ready" });
    await deliverBooking(config, meetingId);
    return;
  }
  const workspace = await loadWorkspace(config, text(meeting.workspace_id));
  const sent = await sendToClay(settings, clayRow(meeting, { name: text(workspace?.name), slug: text(workspace?.slug) }, clayCallbackUrl(settings)));
  if (sent.ok) {
    await saveBooking(config, meetingId, { stage: "enriching", clay: { sent_at: now() } });
    return;
  }
  // Clay refused the row: the booking still goes out, with QC's own enrichment.
  await saveBooking(config, meetingId, { stage: "ready", clay: { error: sent.error } });
  await deliverBooking(config, meetingId);
}

export async function sendToClay(settings: BookingSettings, row: Row): Promise<{ ok: boolean; error?: string }> {
  const url = text(settings.clay_webhook_url);
  if (!url) return { ok: false, error: "No Clay webhook URL is saved." };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (text(settings.clay_auth_token)) headers["x-clay-webhook-auth"] = text(settings.clay_auth_token);
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(row), signal: AbortSignal.timeout(15_000) }).catch((error) => error as Error);
  if (response instanceof Error) return { ok: false, error: `Clay did not answer: ${response.message}` };
  if (!response.ok) return { ok: false, error: `Clay answered ${response.status}: ${(await response.text().catch(() => "")).slice(0, 160)}` };
  return { ok: true };
}

// ── Clay's answer ─────────────────────────────────────────────────────────────────────────────────

/** Columns the person typed on the booking form. Clay fills them only when the form left them empty. */
const FORM_COLUMNS = new Set(["invitee_title", "company_name"]);

/**
 * What Clay's HTTP API column posts. Stores the enrichment and says what to run next. A test row (from the
 * Booked meetings page) is only recorded, so the page can show which fields Clay sent.
 */
export async function intakeClay(config: Config, body: unknown): Promise<{ ok: boolean; status: number; note: string; run?: () => Promise<void> }> {
  const parsed = fromClay(body);
  const received = Object.entries({ ...parsed.fields, ...parsed.tldr }).filter(([, value]) => text(value)).map(([key]) => key);
  await writeSettings(config, { last_clay_callback: { at: now(), meeting_id: parsed.meetingId, test: parsed.test, fields: received } }).catch(() => undefined);
  if (parsed.test) return { ok: true, status: 200, note: `Test row received with ${received.length} fields.` };
  const meeting = await loadMeeting(config, parsed.meetingId);
  if (!meeting) return { ok: false, status: 404, note: "No booking has that meeting_id. Send back the meeting_id column QC added to the row." };
  const patch: Row = {};
  for (const [column, value] of Object.entries(parsed.fields)) {
    const incoming = text(value);
    if (!incoming) continue;
    if (FORM_COLUMNS.has(column) && clean(meeting[column])) continue;
    patch[column] = incoming;
  }
  if (Object.keys(patch).length) await patchMeeting(config, text(meeting.id), patch);
  const booking = bookingOf(meeting);
  const late = booking.stage === "done" || booking.stage === "failed";
  await saveBooking(config, text(meeting.id), {
    clay: { received_at: now() },
    ...(hasTldr(parsed.tldr) ? { tldr: parsed.tldr, tldr_source: "clay" } : {}),
    ...(late ? {} : { stage: "ready" }),
  });
  // After the wait ran out the steps already went with QC's enrichment; Clay's answer is kept, not reposted.
  if (late) return { ok: true, status: 200, note: "Stored. The steps had already run." };
  const id = text(meeting.id);
  return { ok: true, status: 200, note: "Stored. Running the steps.", run: () => deliverBooking(config, id).then(() => undefined) };
}

// ── TLDR ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * The four-part brief for the call, written from the client's brief, the enrichment and our conversation with
 * the person. Used when Clay sent no TLDR of its own. Null when no model is configured or it fails.
 */
async function writeTldr(workspace: Row, meeting: Row): Promise<Tldr | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const conversation = await getMeetingConversation(text(meeting.id)).catch(() => null);
  const transcript = (conversation?.messages ?? []).slice(-30).map((message) => `${message.direction === "inbound" ? "Lead" : "Us"}: ${message.body.slice(0, 800)}`).join("\n");
  const facts = [
    ["Name", meeting.invitee_name], ["Title", meeting.invitee_title], ["Headline", meeting.invitee_headline], ["Location", meeting.invitee_location],
    ["Company", meeting.company_name], ["Domain", meeting.company_domain], ["Industry", meeting.company_industry], ["Size", meeting.company_size],
    ["Type", meeting.company_type], ["Company HQ", meeting.company_location], ["Company description", meeting.company_description],
    ["Meeting", meeting.summary], ["Campaign", meeting.campaign],
  ].filter(([, value]) => clean(value)).map(([label, value]) => `${label}: ${clean(value)}`).join("\n");
  const model = resolveModel(process.env.ANTHROPIC_MODEL);
  const system = [
    `You write the pre-call TLDR for a sales meeting booked with ${text(workspace.name)}.`,
    "Return only JSON with four string fields: lead_summary, lead_call_focus, company_summary, company_call_focus.",
    "lead_summary and company_summary: two or three sentences each on who they are and why they fit.",
    "lead_call_focus and company_call_focus: two or three short lines, each starting with \"- \", on what to lead with on the call.",
    "Use only the facts given. Never invent numbers. Never use em dashes or en dashes.",
  ].join("\n");
  const user = [
    text(workspace.client_brief) ? `What ${text(workspace.name)} sells and who it is for:\n${text(workspace.client_brief).slice(0, 6000)}` : "",
    `The person who booked:\n${facts}`,
    transcript ? `Our LinkedIn conversation with them, oldest first:\n${transcript}` : "",
  ].filter(Boolean).join("\n\n");
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1500, ...temperatureField(model, 0.3), system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const output = (payload.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
    const json = output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
    const parsed = object(JSON.parse(json));
    const tldr: Tldr = {
      leadSummary: stripDashes(text(parsed.lead_summary)),
      leadCallFocus: stripDashes(text(parsed.lead_call_focus)),
      companySummary: stripDashes(text(parsed.company_summary)),
      companyCallFocus: stripDashes(text(parsed.company_call_focus)),
    };
    return hasTldr(tldr) ? tldr : null;
  } catch {
    return null;
  }
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────

type StepContext = { config: Config; workspace: Row; meeting: Row; tldr: Tldr | null; test: boolean; channel: string; previous: StepResult; save: (partial: StepResult) => Promise<void> };

/** The card, then LEAD INFO / COMPANY INFO, then the TLDR, each in the card's thread. Each post is recorded as it lands. */
async function runSlack(step: Step, ctx: StepContext): Promise<StepResult> {
  if (!slackConfigured()) throw new Error("SLACK_BOT_TOKEN is not set.");
  const channel = ctx.test ? ctx.channel : clientConfig(ctx.workspace).channel;
  if (!channel) throw new Error("No bookings channel is set for this client.");
  const logo = text(ctx.workspace.logo_url);
  const identity = { username: clientConfig(ctx.workspace).botName || `${text(ctx.workspace.name)} Calls`, iconUrl: /^https:\/\//i.test(logo) ? logo : "" };
  const result: StepResult = { ...ctx.previous, channel };
  if (!text(result.ts)) {
    const card = buildBookingCard(ctx.meeting, { test: ctx.test });
    result.ts = await postMessage(channel, card.text, "", card.blocks, identity);
    await ctx.save(result);
  }
  if (!text(result.info_ts)) {
    const info = buildInfoThread(ctx.meeting);
    result.info_ts = info.blocks.length ? await postMessage(channel, info.text, text(result.ts), info.blocks, identity) : "none";
    await ctx.save(result);
  }
  if (!text(result.tldr_ts)) {
    const tldr = buildTldrThread(ctx.tldr ?? {});
    result.tldr_ts = tldr.blocks.length ? await postMessage(channel, tldr.text, text(result.ts), tldr.blocks, identity) : "none";
  }
  return result;
}

const HUBSPOT = "https://api.hubapi.com";
async function hubspot(token: string, path: string, init: RequestInit): Promise<{ ok: boolean; status: number; data: Row; text: string }> {
  const response = await fetch(`${HUBSPOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text().catch(() => "");
  let data: Row = {};
  try { data = object(JSON.parse(body)); } catch { /* keep text */ }
  return { ok: response.ok, status: response.status, data, text: body.slice(0, 300) };
}

/**
 * A deal named after the company, as the Zaps made it, with the campaign when the client's HubSpot has a
 * property for it, and the person attached as a contact. A deal already made for this booking is not made twice.
 */
async function runHubSpot(step: Step, ctx: StepContext): Promise<StepResult> {
  const token = text(ctx.workspace.crm_api_key_ciphertext);
  if (text(ctx.workspace.crm_provider) !== "hubspot" || !token) throw new Error("This client has no HubSpot token. Add it under Deals.");
  const result: StepResult = { ...ctx.previous };
  const m = ctx.meeting;
  if (!text(result.deal_id)) {
    const properties: Row = {
      dealname: clean(m.company_name) || clean(m.invitee_name) || "New booking",
      pipeline: step.pipeline || "default",
      dealstage: step.stage || "appointmentscheduled",
    };
    if (step.owner) properties.hubspot_owner_id = step.owner;
    const campaignProperty = step.campaignProperty || "campaign";
    if (clean(m.campaign)) properties[campaignProperty] = clean(m.campaign);
    let created = await hubspot(token, "/crm/v3/objects/deals", { method: "POST", body: JSON.stringify({ properties }) });
    // No such property in this portal: the deal still goes in, without the campaign.
    if (!created.ok && created.status === 400 && /PROPERTY_DOESNT_EXIST|does not exist/i.test(created.text) && campaignProperty in properties) {
      delete properties[campaignProperty];
      result.warning = `HubSpot has no "${campaignProperty}" deal property, so the campaign was left off.`;
      created = await hubspot(token, "/crm/v3/objects/deals", { method: "POST", body: JSON.stringify({ properties }) });
    }
    if (!created.ok) throw new Error(`HubSpot ${created.status}: ${created.text}`);
    result.deal_id = text(created.data.id);
    await ctx.save(result);
  }
  const email = clean(m.invitee_email);
  if (email && !text(result.contact_id)) {
    try {
      const found = await hubspot(token, "/crm/v3/objects/contacts/search", {
        method: "POST",
        body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], limit: 1 }),
      });
      let contactId = text(object((Array.isArray(found.data.results) ? found.data.results : [])[0]).id);
      if (!contactId) {
        const [firstname, ...rest] = clean(m.invitee_name).split(/\s+/);
        const made = await hubspot(token, "/crm/v3/objects/contacts", {
          method: "POST",
          body: JSON.stringify({ properties: { email, firstname: firstname || "", lastname: rest.join(" "), jobtitle: clean(m.invitee_title), company: clean(m.company_name) } }),
        });
        contactId = text(made.data.id);
      }
      if (contactId) {
        await hubspot(token, `/crm/v4/objects/deals/${enc(text(result.deal_id))}/associations/default/contacts/${enc(contactId)}`, { method: "PUT" });
        result.contact_id = contactId;
      }
    } catch (error) {
      result.warning = `Deal made, contact not attached: ${error instanceof Error ? error.message : "HubSpot refused it"}`;
    }
  }
  return result;
}

/** Everything QC knows about the booking, posted as JSON. How a client-specific extra (a Sheet, a CRM) is added. */
async function runWebhook(step: Step, ctx: StepContext): Promise<StepResult> {
  const m = ctx.meeting;
  const pick = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, clean(m[key]) || null]));
  const payload = {
    event: "booking",
    client: text(ctx.workspace.name),
    client_slug: text(ctx.workspace.slug),
    meeting_id: text(m.id),
    meeting_time: clean(m.meeting_at) ? formatMeetingTime(m.meeting_at) : clean(m.when_text),
    ...pick("meeting_at", "summary", "host", "campaign", "status", "invitee_name", "invitee_email", "invitee_title", "invitee_linkedin", "invitee_location", "invitee_headline",
      "company_name", "company_domain", "company_linkedin", "company_location", "company_industry", "company_size", "company_type", "company_description", "created_at"),
    tldr: ctx.tldr ?? null,
  };
  const response = await fetch(String(step.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`The webhook answered ${response.status}.`);
  return { status: response.status };
}

const RUNNERS: Record<string, (step: Step, ctx: StepContext) => Promise<StepResult>> = { slack: runSlack, hubspot: runHubSpot, webhook: runWebhook };

export type DeliverOutcome = { outcome: "done" | "partial" | "busy" | "skipped" | "failed"; reason?: string; steps?: Record<string, StepResult> };

/**
 * Step 3: run the client's steps for one booking. `test` posts the Slack part to the test channel and
 * touches nothing else: no claim, no stored state, no HubSpot, no webhooks.
 */
export async function deliverBooking(config: Config, meetingId: string, opts: { test?: boolean; channel?: string } = {}): Promise<DeliverOutcome> {
  const test = opts.test === true;
  const claimKey = `booking_deliver:${meetingId}`;
  const token = test ? "" : await claim(config, claimKey);
  if (!test && !token) return { outcome: "busy" };
  try {
    let meeting = await loadMeeting(config, meetingId);
    if (!meeting) return { outcome: "skipped", reason: "That booking is not stored." };
    const workspace = await loadWorkspace(config, text(meeting.workspace_id));
    if (!workspace) return { outcome: "skipped", reason: "The client is gone." };
    const settings = clientConfig(workspace);
    let booking = bookingOf(meeting);
    if (!test && (!settings.enabled || workspace.offboarded_at)) {
      await saveBooking(config, meetingId, { stage: "skipped", error: "Booking alerts were off." });
      return { outcome: "skipped", reason: "Booking alerts are off for this client." };
    }
    if (!test && text(meeting.status) === "canceled") {
      await saveBooking(config, meetingId, { stage: "skipped", error: "Canceled before the steps ran." });
      return { outcome: "skipped", reason: "The booking was canceled." };
    }

    // Fill what Clay did not: without a Clay answer, QC's own enrichment (leads we know, then AI Ark); with
    // one, only the campaign, now that Clay found the LinkedIn it is matched on.
    if (!test) {
      if (!booking.clay?.received_at) await enrichMeeting(meetingId).catch(() => false);
      else if (!clean(meeting.campaign)) {
        const known = await matchKnownLead(config, meeting);
        if (known.campaign) await patchMeeting(config, meetingId, { campaign: known.campaign });
      }
      meeting = (await loadMeeting(config, meetingId)) ?? meeting;
      booking = bookingOf(meeting);
    }

    let tldr: Tldr | null = hasTldr(booking.tldr) ? (booking.tldr as Tldr) : null;
    if (!tldr) {
      tldr = await writeTldr(workspace, meeting);
      if (tldr && !test) booking = await saveBooking(config, meetingId, { tldr, tldr_source: "qc" });
    }

    const steps = settings.steps.filter((step) => step.enabled && (!test || step.type === "slack"));
    const results: Record<string, StepResult> = { ...(test ? {} : booking.steps ?? {}) };
    for (const step of steps) {
      const previous = results[step.id] ?? {};
      if (previous.done_at || (Number(previous.attempts) || 0) >= MAX_ATTEMPTS) continue;
      const runner = RUNNERS[step.type];
      if (!runner) continue;
      const save = async (partial: StepResult) => {
        results[step.id] = partial;
        if (!test) await saveBooking(config, meetingId, { steps: { [step.id]: partial } });
      };
      try {
        const result = await runner(step, { config, workspace, meeting, tldr, test, channel: text(opts.channel), previous, save });
        results[step.id] = { ...result, done_at: now(), error: undefined };
      } catch (error) {
        results[step.id] = { ...results[step.id], error: error instanceof Error ? error.message.slice(0, 400) : "Failed.", failed_at: now(), attempts: (Number(previous.attempts) || 0) + 1 };
      }
      if (!test) await saveBooking(config, meetingId, { steps: { [step.id]: results[step.id] } });
    }

    const open = steps.filter((step) => !results[step.id]?.done_at);
    const exhausted = open.every((step) => (Number(results[step.id]?.attempts) || 0) >= MAX_ATTEMPTS);
    const errors = open.map((step) => `${step.type}: ${text(results[step.id]?.error)}`).join(" · ");
    if (!test) {
      await saveBooking(config, meetingId, open.length
        ? { stage: exhausted ? "failed" : "ready", error: errors, next_try_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() }
        : { stage: "done", error: "" });
      if (!open.length) {
        await writeAuditEvent(config, {
          actor: "slack_bot",
          action: "booking_alert.posted",
          entityType: "meeting",
          entityId: meetingId,
          details: { source: "booking_alerts", status: "success", workspaceId: text(workspace.id), workspaceName: text(workspace.name), summary: `Booking from ${clean(meeting.invitee_name) || "someone"} posted and filed.` },
        }).catch(() => undefined);
      }
    }
    return { outcome: open.length ? (open.length === steps.length ? "failed" : "partial") : "done", reason: errors || undefined, steps: results };
  } finally {
    if (token) await release(config, claimKey, token).catch(() => undefined);
  }
}

// ── Sweep ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The worker's backup, every minute: a booking whose after() never ran, one Clay has not answered within the
 * wait, and one with a step to retry. Two days back at most.
 */
export async function sweepBookings(config: Config): Promise<{ checked: number; ran: number }> {
  const settings = await readSettings(config);
  const waitMs = Math.max(1, Number(settings.clay_wait_minutes) || DEFAULT_CLAY_WAIT_MINUTES) * 60 * 1000;
  const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const due = await rows(config, `rr_meetings?select=id,created_at,booking&booking->>stage=in.(new,enriching,ready)&created_at=gte.${enc(since)}&order=created_at.asc&limit=40`);
  let ran = 0;
  for (const row of due) {
    if (ran >= 6) break;
    const booking = bookingOf(row);
    const id = text(row.id);
    const age = Date.now() - Date.parse(text(booking.received_at) || text(row.created_at));
    if (booking.stage === "new" && age > 2 * 60 * 1000) {
      await startBooking(config, id).catch(() => undefined);
      ran += 1;
    } else if (booking.stage === "enriching" && Date.now() - Date.parse(text(booking.clay?.sent_at)) > waitMs) {
      await saveBooking(config, id, { stage: "ready", clay: { timed_out: true } });
      await deliverBooking(config, id).catch(() => undefined);
      ran += 1;
    } else if (booking.stage === "ready" && age > 60 * 1000 && (!booking.next_try_at || Date.parse(booking.next_try_at) <= Date.now())) {
      await deliverBooking(config, id).catch(() => undefined);
      ran += 1;
    }
  }
  return { checked: due.length, ran };
}

// ── Tests from the page ───────────────────────────────────────────────────────────────────────────

/** "Send a test": the client's latest booking, its Slack part only, to the Slack test channel. */
export async function bookingTest(config: Config, workspaceId: string): Promise<DeliverOutcome> {
  const channel = (process.env[TEST_CHANNEL_ENV] ?? "").trim();
  if (!channel) return { outcome: "failed", reason: `${TEST_CHANNEL_ENV} is not set, so there is no test channel.` };
  const [latest] = await rows(config, `rr_meetings?select=id&workspace_id=eq.${enc(workspaceId)}&order=created_at.desc&limit=1`);
  if (!latest) return { outcome: "skipped", reason: "This client has no booked meetings yet." };
  return deliverBooking(config, text(latest.id), { test: true, channel });
}

/** A made-up row sent to the Clay table, marked as a test, to check the table answers back. */
export async function clayTest(config: Config, request?: Request): Promise<{ ok: boolean; error?: string }> {
  const settings = await ensureCallbackSecret(config, await readSettings(config), request);
  return sendToClay(settings, clayRow({
    id: "test",
    invitee_name: "Tim Puri",
    invitee_email: "",
    company_name: "Curana Health",
    invitee_title: "Chief Medical Officer, Population Health",
    summary: "Test booking",
    meeting_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  }, { name: "QC Command test", slug: "test" }, clayCallbackUrl(settings), true));
}

// ── Calendly ──────────────────────────────────────────────────────────────────────────────────────

const CALENDLY = "https://api.calendly.com";
async function calendly(token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: Row }> {
  const response = await fetch(path.startsWith("http") ? path : `${CALENDLY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text().catch(() => "");
  let data: Row = {};
  try { data = object(JSON.parse(body)); } catch { data = { message: body.slice(0, 200) }; }
  return { ok: response.ok, status: response.status, data };
}

const calendlyError = (result: { status: number; data: Row }) =>
  text(result.data.message) || text(result.data.title) || `Calendly answered ${result.status}.`;

/**
 * Connects a Calendly account: checks the token, then subscribes QC's webhook to bookings and cancels.
 * Organization-wide when the token's owner is an admin (every teammate's event types), otherwise just that
 * user's. A subscription Calendly already has for this URL is replaced, because only a fresh one carries
 * QC's signing key.
 */
export async function connectCalendly(token: string, callbackUrl: string): Promise<{ ok: true; connection: CalendlyConnection } | { ok: false; error: string }> {
  const me = await calendly(token, "/users/me");
  if (!me.ok) return { ok: false, error: me.status === 401 ? "Calendly did not accept that token." : calendlyError(me) };
  const user = object(me.data.resource);
  const userUri = text(user.uri);
  const orgUri = text(user.current_organization);
  const signingKey = randomBytes(24).toString("hex");
  const events = ["invitee.created", "invitee.canceled"];
  const subscribe = (scope: string) => calendly(token, "/webhook_subscriptions", {
    method: "POST",
    body: JSON.stringify({ url: callbackUrl, events, organization: orgUri, ...(scope === "user" ? { user: userUri } : {}), scope, signing_key: signingKey }),
  });
  const replaceExisting = async (scope: string) => {
    const query = new URLSearchParams({ organization: orgUri, scope, count: "100", ...(scope === "user" ? { user: userUri } : {}) });
    const list = await calendly(token, `/webhook_subscriptions?${query}`);
    const collection = Array.isArray(list.data.collection) ? (list.data.collection as Row[]) : [];
    for (const hook of collection) if (text(hook.callback_url) === callbackUrl) await calendly(token, text(hook.uri), { method: "DELETE" });
  };
  let scope = "organization";
  let created = await subscribe(scope);
  if (created.status === 409) { await replaceExisting(scope); created = await subscribe(scope); }
  if (!created.ok && (created.status === 403 || created.status === 401)) {
    scope = "user";
    created = await subscribe(scope);
    if (created.status === 409) { await replaceExisting(scope); created = await subscribe(scope); }
  }
  if (!created.ok) {
    const why = calendlyError(created);
    return { ok: false, error: /upgrade|plan|premium|standard/i.test(why) ? `Calendly webhooks need a paid Calendly plan (${why})` : why };
  }
  return {
    ok: true,
    connection: {
      email: text(user.email),
      name: text(user.name),
      user_uri: userUri,
      org_uri: orgUri,
      scope,
      subscription_uri: text(object(created.data.resource).uri),
      signing_key: signingKey,
      url: callbackUrl,
      connected_at: now(),
    },
  };
}

export async function disconnectCalendly(token: string, connection: CalendlyConnection | null): Promise<void> {
  if (token && connection?.subscription_uri) await calendly(token, connection.subscription_uri, { method: "DELETE" }).catch(() => undefined);
}

/** Calendly-Webhook-Signature: "t=<unix>,v1=<hex hmac of `${t}.${body}`>". */
export function calendlySignatureValid(header: string, rawBody: string, signingKey: string): boolean {
  if (!signingKey) return false;
  const parts = Object.fromEntries(String(header ?? "").split(",").map((part) => part.trim().split("=") as [string, string]));
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac("sha256", signingKey).update(`${parts.t}.${rawBody}`).digest("hex");
  return secretMatches(parts.v1, expected);
}

/** cal.com's X-Cal-Signature-256: the hex HMAC of the raw body with the secret set on the webhook. */
export function calComSignatureValid(header: string, rawBody: string, secret: string): boolean {
  if (!secret) return false;
  return secretMatches(String(header ?? ""), createHmac("sha256", secret).update(rawBody).digest("hex"));
}

export { loadWorkspace, WORKSPACE_COLUMNS };
