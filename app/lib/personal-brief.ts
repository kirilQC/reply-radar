// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The personal assistant: a per-person morning brief.
 *
 * Where the morning brief is one client posted to that client's channel, this is one PERSON DM'd a single note
 * that spans the clients they own — "here is what you need to focus on today." It reuses the brief engine
 * wholesale: for each of the person's clients it takes that client's morning brief (the one already sent this
 * morning, when there is one, else freshly written) and then a second model call folds those briefs into one
 * prioritized focus note addressed to the person. So the facts are exactly the morning brief's facts; the only
 * new thing is the cross-client triage.
 *
 * Configuration lives in `rr_slack_personal_assistants`, one row per person (name, Slack user id, the client
 * slugs they track, and a schedule). The schedule maths and the "already sent today" check are the same pure
 * functions the morning brief uses.
 */

import {
  gatherSignals,
  briefUserContent,
  type BriefWorkspace,
} from "./morning-brief";
import {
  gatherChannels,
  gatherCalls,
  gatherLiveFigures,
  gatherPriorBriefs,
  morningBriefPrompt,
  writeBrief,
} from "./morning-brief-run";
import { brainContext } from "./brain-context";
import { type BriefSchedule } from "./morning-brief-schedule";
import { openDm, postMessage } from "./slack";

type Row = Record<string, unknown>;

export type PersonalAssistant = {
  id: string;
  personName: string;
  slackUserId: string;
  clientSlugs: string[];
  enabled: boolean;
  sendDays: number[];
  sendHour: number;
  sendMinute: number;
  timezone: string;
  lastSentAt: string | null;
};

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => str(v)).filter(Boolean) : []);
const asDays = (value: unknown): number[] => (Array.isArray(value) ? value.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : []);

export function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function headers(key: string) {
  return { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
}
export function reader(url: string, key: string) {
  return async (path: string): Promise<unknown> => {
    const response = await fetch(`${url}/rest/v1/${path}`, { headers: headers(key), cache: "no-store" });
    if (!response.ok) throw new Error(`Supabase read failed (${response.status})`);
    return response.json();
  };
}
const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

export function assistantFromRow(row: Row): PersonalAssistant {
  return {
    id: str(row.id),
    personName: str(row.person_name),
    slackUserId: str(row.slack_user_id),
    clientSlugs: asList(row.client_slugs),
    enabled: Boolean(row.enabled),
    sendDays: asDays(row.send_days),
    sendHour: Number.isFinite(Number(row.send_hour)) ? Number(row.send_hour) : 8,
    sendMinute: Number.isFinite(Number(row.send_minute)) ? Number(row.send_minute) : 0,
    timezone: str(row.timezone) || "America/New_York",
    lastSentAt: row.last_sent_at ? str(row.last_sent_at) : null,
  };
}

/** A personal assistant's schedule, in the same shape the morning brief's due-maths expects. */
export function assistantSchedule(a: PersonalAssistant): BriefSchedule {
  return { enabled: a.enabled, sendDays: a.sendDays.length ? a.sendDays : [1, 2, 3, 4, 5], sendHour: a.sendHour, sendMinute: a.sendMinute, timezone: a.timezone, destination: "dm" };
}

// A brief already written this morning is reused rather than regenerated: within this window we trust it as
// today's, so the personal note is a triage of real briefs, not a fresh (and costly) six-client generation.
const REUSE_BRIEF_MS = 20 * 60 * 60 * 1000;

const BRIEF_COLUMNS = "id,name,slug,timezone,client_brief,brain_folder,slack_internal_channel_id,slack_external_channel_id,granola_title_match,heyreach_api_key_ciphertext";

/**
 * One client's brief body for the person's note: the most recent morning brief if it is fresh, otherwise a
 * fresh one written the exact same way the morning-brief route writes it. Never throws — a client that cannot
 * be produced comes back with an empty body and is simply left out of the note.
 */
async function briefBodyForClient(read: (path: string) => Promise<unknown>, slug: string): Promise<{ client: string; body: string }> {
  const rows = await read(`rr_workspaces?select=${BRIEF_COLUMNS},slack_extra_channel_ids,granola_extra_title_matches&slug=eq.${encodeURIComponent(slug)}&limit=1`)
    .catch(() => read(`rr_workspaces?select=${BRIEF_COLUMNS}&slug=eq.${encodeURIComponent(slug)}&limit=1`));
  const found = rowsOf(rows)[0];
  if (!found) return { client: slug, body: "" };
  const workspace = found as BriefWorkspace;

  // Reuse this morning's brief when there is one.
  try {
    const recent = rowsOf(await read(`rr_slack_briefs?select=body,created_at&workspace_id=eq.${encodeURIComponent(str(found.id))}&automation=eq.morning_brief&status=eq.success&order=created_at.desc&limit=1`))[0];
    if (recent && str(recent.body).trim() && Date.now() - Date.parse(str(recent.created_at)) < REUSE_BRIEF_MS) {
      return { client: workspace.name, body: str(recent.body) };
    }
  } catch { /* fall through to generating a fresh one */ }

  // Otherwise write one fresh, mirroring the morning-brief route.
  try {
    const live = await gatherLiveFigures(str(found.heyreach_api_key_ciphertext));
    const [signals, channels, call, systemPrompt, brain, priorBriefs] = await Promise.all([
      gatherSignals(read, workspace, live),
      gatherChannels(workspace),
      gatherCalls(read, workspace),
      morningBriefPrompt(workspace.slug),
      brainContext(workspace),
      gatherPriorBriefs(read, workspace),
    ]);
    const inputs = { signals, ...channels, call: call.call, callReason: call.callReason, extraCalls: call.extras, brain: brain.block, priorBriefs };
    const body = await writeBrief(systemPrompt, briefUserContent(workspace, inputs));
    return { client: workspace.name, body: str(body) };
  } catch {
    return { client: workspace.name, body: "" };
  }
}

const firstNameOf = (name: string) => str(name).trim().split(/\s+/)[0] || "there";

function personalSystemPrompt(personName: string): string {
  const first = firstNameOf(personName);
  return `You are ${first}'s personal delivery assistant at QC, a B2B outbound growth agency. Every morning you DM ${first} one short, scannable note pulling together the clients they own, so they open Slack and in five seconds know where to put their attention today.

You are given today's morning brief for each of ${first}'s clients, one after another, each headed by the client's name. Those briefs are the facts. Never invent anything not in them, and never restate a figure differently from how it is given.

Your job is triage, not a recap. Surface only the few things that actually need ${first} today, grouped by client, in priority order. Most of what is in the briefs does not need ${first} personally.

FORMAT — follow it exactly:
- Group by client. Each client that has something for ${first} today gets its name in bold on its own line, for example: *Steadywell*
- Under that name, one line per item. Each line starts with a status emoji, then a terse fragment (never a full sentence). Bold a campaign code or the key number. Example of the whole shape:
  *Steadywell*
  :red_circle: SW015 ~2 days of leads left, queue the next batch
  :hourglass_flowing_sand: Advisory-council re-engagement overdue

  *Bluevia*
  :red_circle: BV011 ~2 days left, load leads and launch Batch 3
  :raising_hand: Lyna owes the union names and the conference decision
- The three status emojis and their exact meaning:
  :red_circle: needs action from ${first} today (a campaign about to run dry, a hot reply waiting, a launch or decision needed on our side)
  :hourglass_flowing_sand: a commitment of ours that is overdue
  :raising_hand: we are waiting on the client (they owe us something)
- Order items within a client by priority (:red_circle: first, then :hourglass_flowing_sand:, then :raising_hand:). Order the clients so the one with the most urgent item comes first.
- At most three items per client. A client with nothing for ${first} today is left out entirely, never written as "all good". Keep the whole note under about ten lines including the client names.
- No greeting, no preamble, no summary sentence, no headings, no '#', no tables. Start straight with the first client's bold name.
- End with exactly this legend line and nothing after it: :red_circle: needs action  ·  :hourglass_flowing_sand: overdue  ·  :raising_hand: waiting on client
- Slack mrkdwn only: *bold* with single asterisks, _italic_ with underscores. Never an em dash or en dash; use a comma or a middot (·).
- If, across every client, there is genuinely nothing that needs ${first} today, skip all of the above and say so in one honest line instead.`;
}

/** The DM's one-line header: a greeting for the person, dated in their timezone. */
function personalHeader(personName: string, timezone: string): string {
  let dateLabel = "";
  try {
    dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone || "America/New_York" }).format(new Date());
  } catch {
    dateLabel = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  }
  return `*Good morning ${firstNameOf(personName)} — your focus for ${dateLabel}*  :sunrise:`;
}

/** Build the person's focus note across their clients. Returns the digest text, or an error. */
export async function composePersonalBrief(person: PersonalAssistant): Promise<{ ok: boolean; digest?: string; clients?: string[]; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const slugs = [...new Set(person.clientSlugs.map((s) => str(s).trim()).filter(Boolean))];
  if (!slugs.length) return { ok: false, error: "This assistant has no clients selected." };
  const read = reader(url, key);

  const perClient = await Promise.all(slugs.map((slug) => briefBodyForClient(read, slug).catch(() => ({ client: slug, body: "" }))));
  const withBody = perClient.filter((c) => c.body.trim());
  if (!withBody.length) return { ok: false, error: "None of this person's clients produced a brief (check their client configs)." };

  const sections = withBody.map((c) => `## ${c.client}\n\n${c.body}`).join("\n\n---\n\n");
  const userContent = `${person.personName} owns the clients below. Here is today's morning brief for each. Write ${firstNameOf(person.personName)}'s personal focus note across all of them.\n\n---\n\n${sections}`;
  const digest = await writeBrief(personalSystemPrompt(person.personName), userContent);
  return { ok: true, digest: str(digest), clients: withBody.map((c) => c.client) };
}

/** Compose and DM the person their focus note, stamping last_sent_at on success. */
export async function sendPersonalBrief(person: PersonalAssistant): Promise<{ ok: boolean; error?: string; clients?: string[] }> {
  const composed = await composePersonalBrief(person);
  if (!composed.ok || !composed.digest) return { ok: false, error: composed.error || "Nothing to send." };
  if (!person.slackUserId.trim()) return { ok: false, error: "This assistant has no Slack user id to DM." };

  const channel = await openDm(person.slackUserId);
  if (!channel) return { ok: false, error: "Could not open a DM with that Slack user id (check the id and the bot's im:write scope)." };
  const headerTs = await postMessage(channel, personalHeader(person.personName, person.timezone));
  await postMessage(channel, composed.digest, headerTs);

  const { url, key } = config();
  if (url && key) {
    await fetch(`${url}/rest/v1/rr_slack_personal_assistants?id=eq.${encodeURIComponent(person.id)}`, {
      method: "PATCH", headers: headers(key), body: JSON.stringify({ last_sent_at: new Date().toISOString() }),
    }).catch(() => {});
  }
  return { ok: true, clients: composed.clients };
}

// ── Config store (rr_slack_personal_assistants) ────────────────────────────────────────────────────

export async function listAssistants(): Promise<PersonalAssistant[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  const read = reader(url, key);
  const rows = rowsOf(await read(`rr_slack_personal_assistants?select=*&order=person_name.asc`).catch(() => []));
  return rows.map(assistantFromRow);
}

export async function upsertAssistant(input: {
  id?: string; personName: string; slackUserId: string; clientSlugs: string[];
  enabled: boolean; sendDays: number[]; sendHour: number; sendMinute: number; timezone: string;
}): Promise<{ ok: boolean; error?: string; assistant?: PersonalAssistant }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  if (!str(input.personName).trim()) return { ok: false, error: "A name is required." };
  const record: Row = {
    person_name: str(input.personName).trim(),
    slack_user_id: str(input.slackUserId).trim(),
    client_slugs: asList(input.clientSlugs),
    enabled: Boolean(input.enabled),
    send_days: asDays(input.sendDays).length ? asDays(input.sendDays) : [1, 2, 3, 4, 5],
    send_hour: Number.isFinite(Number(input.sendHour)) ? Number(input.sendHour) : 8,
    send_minute: Number.isFinite(Number(input.sendMinute)) ? Number(input.sendMinute) : 0,
    timezone: str(input.timezone) || "America/New_York",
    updated_at: new Date().toISOString(),
  };
  const id = str(input.id).trim();
  const target = id
    ? `${url}/rest/v1/rr_slack_personal_assistants?id=eq.${encodeURIComponent(id)}`
    : `${url}/rest/v1/rr_slack_personal_assistants`;
  const response = await fetch(target, {
    method: id ? "PATCH" : "POST",
    headers: { ...headers(key), Prefer: "return=representation" },
    body: JSON.stringify(record),
  });
  if (!response.ok) return { ok: false, error: "Could not save this assistant." };
  const saved = rowsOf(await response.json().catch(() => []))[0];
  return { ok: true, assistant: saved ? assistantFromRow(saved) : undefined };
}

export async function deleteAssistant(id: string): Promise<{ ok: boolean }> {
  const { url, key } = config();
  if (!url || !key || !id) return { ok: false };
  const response = await fetch(`${url}/rest/v1/rr_slack_personal_assistants?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: headers(key) });
  return { ok: response.ok };
}

/** The client directory for the multi-select: id, name, slug. */
export async function personalClientDirectory(): Promise<Array<{ id: string; name: string; slug: string; logoUrl: string | null }>> {
  const { url, key } = config();
  if (!url || !key) return [];
  const read = reader(url, key);
  const rows = rowsOf(await read(`rr_workspaces?select=id,name,slug,logo_url&order=name.asc`).catch(() => []));
  return rows.filter((r) => str(r.name).trim()).map((r) => ({ id: str(r.id), name: str(r.name), slug: str(r.slug), logoUrl: str(r.logo_url) || null }));
}
