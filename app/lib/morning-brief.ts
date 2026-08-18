// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The morning brief: what a project manager would say about one client on a Monday.
 *
 * ── What makes this trustworthy, and what would kill it ─────────────────────────────────────────
 * A brief that nags about work already finished, or invents a deadline nobody set, gets muted inside a
 * fortnight — and a muted brief is worse than no brief, because the numbers in it stop being checked
 * while everyone assumes they still are. Two things guard against that, and they are both structural
 * rather than a matter of prompt wording:
 *
 * 1. Every number the brief states is computed here, in `gatherSignals`, and handed to the model as
 *    fact. The model is never asked to count anything, work out a percentage, or judge whether sending
 *    is down. It is asked to explain and prioritise figures that are already true. A model that cannot
 *    invent a number cannot be wrong about one.
 * 2. Every claim about a person has to point at something they said. The transcript is supplied with
 *    names and days attached, and the prompt requires an attribution for each commitment raised. A
 *    commitment the model cannot attribute is one it made up, and the prompt says to drop it.
 *
 * ── Why the figures are not the interesting part ────────────────────────────────────────────────
 * The analytics page already shows the figures, better than a Slack message could. The reason to write
 * this at all is the join: "Willow's sends stopped on Tuesday and nobody in the channel has mentioned
 * Willow since Monday" is a sentence neither the dashboard nor the channel can produce alone, and it is
 * the one worth waking up to.
 */

/**
 * ── Nothing is imported here, on purpose ────────────────────────────────────────────────────────
 * Everything that touches Slack, Supabase or Anthropic lives in `morning-brief-run.ts`. This file is
 * arithmetic and wording, which means the tests can run it directly — and the arithmetic is the part
 * that has to be right, because a figure in a brief is read by the people least likely to check it.
 */

/** The global prompt, and one variant per client that overrides it. Mirrors the sentiment prompt. */
export const MORNING_BRIEF_PROMPT_PREFIX = "morning_brief_prompt";
export const morningBriefPromptKey = (slug?: string | null) =>
  slug ? `${MORNING_BRIEF_PROMPT_PREFIX}_${slug}` : MORNING_BRIEF_PROMPT_PREFIX;

/** How far back the brief looks at Slack. A week, so a Monday brief covers the week that just ended. */
export const BRIEF_WINDOW_DAYS = 7;

/**
 * How many messages of one channel to read. Two hundred is a busy week; past that the oldest are noise.
 *
 * Here rather than beside the fetch because the trace has to be able to say the cap was reached, and a
 * cap stated in one file and reported from another is a cap that eventually stops matching.
 */
export const BRIEF_MAX_MESSAGES = 200;

/**
 * How far back to look for a call. Longer than the Slack window on purpose: weeklies get moved, skipped
 * for a holiday, or held every other week, and the commitments made on the last one stand until the next
 * one happens. A fortnight finds the call that is still in force rather than only this week's.
 */
export const CALL_WINDOW_DAYS = 14;

export const DEFAULT_MORNING_BRIEF_PROMPT = `You are the project manager for one client of a B2B outbound growth agency. You are writing the short brief that lands in the team's Slack channel first thing in the morning. The people reading it ran this account last week and will run it today: they do not need to be told what outbound is, what the client sells, or what a connection request is.

You will be given, for one client:
- **Figures**, computed from the agency's own records. These are facts. Never restate a figure differently from how it is given, never compute a new one, and never estimate.
- **The internal channel**, where the team talks about this client.
- **The external channel**, shared with the client, if there is one.
- **The last call**, a transcript of the most recent call with this client, if there was one. This is where the agency states out loud what it will do next, so it is the strongest evidence of what was promised.
- **The client brief**, which may state what this account is supposed to be doing.

## What to write

Write between 120 and 300 words as Slack mrkdwn. Lead with the thing that would change what somebody does today. If nothing needs doing, say that in one line and stop — a short honest brief is the point, and padding one out is how it stops being read.

Use these sections, and drop any that has nothing real in it:

*Needs a decision today* — anything blocked, waiting on us, or about to slip. One line each, naming who it is on.
*We said we would* — what the agency committed to on the last call, where nothing since suggests it has happened. Quote the commitment. This is the most valuable section in the brief when there was a recent call, because a promise made out loud to a client and then forgotten is the failure this brief exists to prevent.
*Slipped* — commitments from the internal channel that had a date and did not land. Name the person and quote enough of what they said to be recognisable. If a message says it was finished, it is finished — do not raise it.
*The numbers* — only figures that changed meaningfully or that contradict what the channel says. Not a recap of the dashboard.
*The client is waiting* — anything asked in the external channel that nobody answered.

## Rules

- Every commitment you raise must be attributable to a message or a line of the transcript you were given. Say who said it and roughly when. If you cannot point at it, leave it out.
- A commitment on a call that a later Slack message says is done is done. Check the channels before raising anything from the transcript.
- The transcript is a machine transcription and misspells names and product terms. Do not quote a mangled word as though it were said that way, and do not build a finding on one word you cannot make sense of.
- Do not invent deadlines. A deadline exists only if somebody stated one, or the client brief states one. "Should probably be done soon" is not a deadline and must not be written as one.
- Where the figures and the channel disagree, that disagreement is the most valuable line in the brief. Say both sides plainly: what the records show, and what the channel said.
- Never guess at why something happened. "Sends stopped on Wednesday" is useful. "Sends stopped on Wednesday, probably because of the LinkedIn limits" is not, unless somebody said so.
- Silence is a finding, not an absence. A client nobody has mentioned in a week is worth one line.
- Do not thank anyone, do not encourage anyone, do not close with a summary or a question. End on the last finding.
- Slack mrkdwn only: *bold* with single asterisks, _italic_ with underscores, • or - for bullets. No markdown headings, no tables, no code fences, and no @-mentions — the brief must not ping anybody.`;

export type BriefWorkspace = {
  id: string;
  name: string;
  slug: string;
  timezone?: string | null;
  client_brief?: string | null;
  slack_internal_channel_id?: string | null;
  slack_external_channel_id?: string | null;
  granola_title_match?: string | null;
};

type Row = Record<string, unknown>;
type Reader = (path: string) => Promise<unknown>;

export type BriefSignals = {
  campaigns: { total: number; active: number; paused: number; names: { name: string; status: string; sent: number; accepted: number; replies: number; pending: number }[] };
  sending: { thisWeek: number; lastWeek: number; changePercent: number | null; lastDayWithSends: string | null; quietDays: number };
  replies: { thisWeek: number; lastWeek: number };
  acceptance: { thisWeek: number | null; lastWeek: number | null };
  // `dayCount` is how many days were on record at all, which is the only honest way to tell "nothing
  // was sent" apart from "nothing has been collected". `statsAgeHours` comes from the campaign rows and
  // is advisory: it can be unknown while the daily figures are perfectly good.
  staleness: { statsAgeHours: number | null; dayCount: number };
};

const int = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const rate = (accepted: number, sent: number) => (sent > 0 ? Math.round((accepted / sent) * 1000) / 10 : null);

/**
 * Everything the brief is allowed to state as fact, computed rather than asked for.
 *
 * The two windows are seven days each, back to back, because a figure with nothing to compare it
 * against cannot say whether anything changed — and "has anything changed" is the only question a
 * recurring brief is really asking. `quietDays` is counted from the last day with any sends at all
 * rather than from today, so a client that stopped a fortnight ago reads as a fortnight, not as zero.
 */
export async function gatherSignals(read: Reader, workspace: BriefWorkspace): Promise<BriefSignals> {
  const filter = `workspace_id=eq.${encodeURIComponent(workspace.id)}`;
  const [campaignRows, dailyRows] = await Promise.all([
    read(`rr_campaign_stats?select=name,status,connections_sent,connections_accepted,replies,leads_pending,refreshed_at&${filter}&order=connections_sent.desc&limit=60`),
    read(`rr_daily_stats?select=day,connections_sent,connections_accepted,replies&${filter}&sender_id=eq.&order=day.desc&limit=21`),
  ]);
  const campaigns = Array.isArray(campaignRows) ? (campaignRows as Row[]) : [];
  const days = Array.isArray(dailyRows) ? (dailyRows as Row[]) : [];

  const isActive = (status: unknown) => /active|running|in ?progress/i.test(String(status ?? ""));
  const isPaused = (status: unknown) => /pause|stopped|hold/i.test(String(status ?? ""));

  // `days` is newest first, so the first seven rows are the recent window and the next seven the one
  // before it. Rows are only written for days HeyReach reported, so a gap is a day with no sending.
  const window = (from: number, to: number) => days.slice(from, to);
  const sum = (rows: Row[], column: string) => rows.reduce((total, row) => total + int(row[column]), 0);
  const recent = window(0, 7);
  const previous = window(7, 14);
  const thisWeek = sum(recent, "connections_sent");
  const lastWeek = sum(previous, "connections_sent");

  const withSends = days.find((row) => int(row.connections_sent) > 0);
  const lastDayWithSends = withSends ? String(withSends.day ?? "") : null;
  const quietDays = lastDayWithSends
    ? Math.max(0, Math.round((Date.now() - Date.parse(`${lastDayWithSends}T12:00:00Z`)) / 86_400_000))
    : days.length;

  const freshest = campaigns.reduce((newest, row) => Math.max(newest, Date.parse(String(row.refreshed_at ?? "")) || 0), 0);

  return {
    campaigns: {
      total: campaigns.length,
      active: campaigns.filter((row) => isActive(row.status)).length,
      paused: campaigns.filter((row) => isPaused(row.status)).length,
      // The ten biggest by volume. A client with sixty campaigns has a long tail of finished ones that
      // would fill the prompt without changing a single line of the brief.
      names: campaigns.slice(0, 10).map((row) => ({
        name: String(row.name ?? ""),
        status: String(row.status ?? "unknown"),
        sent: int(row.connections_sent),
        accepted: int(row.connections_accepted),
        replies: int(row.replies),
        pending: int(row.leads_pending),
      })),
    },
    sending: {
      thisWeek,
      lastWeek,
      changePercent: lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null,
      lastDayWithSends,
      quietDays,
    },
    replies: { thisWeek: sum(recent, "replies"), lastWeek: sum(previous, "replies") },
    acceptance: {
      thisWeek: rate(sum(recent, "connections_accepted"), thisWeek),
      lastWeek: rate(sum(previous, "connections_accepted"), lastWeek),
    },
    staleness: { statsAgeHours: freshest ? Math.round((Date.now() - freshest) / 3_600_000) : null, dayCount: days.length },
  };
}

/**
 * The figures as prose, because a model reading JSON writes about JSON.
 *
 * Every line is stated in the form the brief should repeat it in, and the ones that are unknown say so
 * rather than being dropped — a missing line reads as a zero, and "no figures have been collected yet"
 * is a completely different brief from "nothing was sent".
 */
export function signalsAsText(signals: BriefSignals): string {
  const lines: string[] = [];
  const { campaigns, sending, replies, acceptance, staleness } = signals;

  // "Nothing has been collected" is the only case where the figures must be withheld, and it is not the
  // same as "no campaign row carried a timestamp": the daily figures are written by their own sync and
  // are perfectly good on their own. Gating on the timestamp suppressed a real week of sending.
  if (!campaigns.total && !staleness.dayCount) {
    lines.push("No figures have ever been collected for this client, so nothing below is known. Say so rather than reporting zeros.");
    return lines.join("\n");
  }
  if (staleness.statsAgeHours !== null && staleness.statsAgeHours > 36) lines.push(`These figures were last collected ${staleness.statsAgeHours} hours ago, so they may be behind.`);

  if (!campaigns.total) lines.push("No campaign records have been collected for this client, so which campaigns these figures came from is not known.");
  else lines.push(`Campaigns: ${campaigns.total} total, ${campaigns.active} active, ${campaigns.paused} paused or stopped.`);
  for (const campaign of campaigns.names) {
    const accepted = rate(campaign.accepted, campaign.sent);
    lines.push(`- "${campaign.name}" (${campaign.status}): ${campaign.sent} sent, ${campaign.accepted} accepted${accepted === null ? "" : ` (${accepted}%)`}, ${campaign.replies} replies, ${campaign.pending} leads not yet contacted.`);
  }

  lines.push(`Connection requests sent in the last 7 days: ${sending.thisWeek}. In the 7 days before that: ${sending.lastWeek}.`);
  if (sending.changePercent !== null) lines.push(`That is a change of ${sending.changePercent > 0 ? "+" : ""}${sending.changePercent}% week on week.`);
  if (!sending.lastDayWithSends) lines.push("There is no record of any sending at all in the last three weeks.");
  else if (sending.quietDays >= 2) lines.push(`Nothing has been sent since ${sending.lastDayWithSends} — that is ${sending.quietDays} days quiet.`);

  lines.push(`Replies in the last 7 days: ${replies.thisWeek}. In the 7 days before that: ${replies.lastWeek}.`);
  if (acceptance.thisWeek !== null) lines.push(`Acceptance rate over the last 7 days: ${acceptance.thisWeek}%${acceptance.lastWeek === null ? "" : `, against ${acceptance.lastWeek}% the week before`}.`);

  return lines.join("\n");
}

/**
 * The client's most recent call. Shaped here rather than imported from `granola.ts`, because this file
 * is not allowed a relative import — see the note at the top.
 */
export type BriefCall = {
  title: string;
  ageDays: number | null;
  owner: string;
  summary: string;
  transcript: string;
  truncated: boolean;
  /**
   * The three below are for the trace, not the prompt. The model is told the call's age in words because
   * that is what changes how it should read a commitment; who was in the room and how long it ran change
   * nothing it writes, and would only be more context to get wrong.
   */
  startedAt?: number;
  attendees?: string[];
  durationMinutes?: number | null;
};

/** One channel as it was read: what was configured, what came back, and what survived filtering. */
export type BriefChannel = {
  channelId: string;
  messages: number;
  text: string;
  error?: string;
  /** What Slack returned before joins and empty messages were dropped. */
  raw?: number;
  /** Whether `BRIEF_MAX_MESSAGES` was reached, which means the oldest of the window is missing. */
  capped?: boolean;
};

export type BriefInputs = {
  signals: BriefSignals;
  internal: BriefChannel;
  external: BriefChannel;
  /** Null when there was no call to find, or none could be read. `callReason` says which. */
  call?: BriefCall | null;
  callReason?: string;
};

/** What the model is shown, in the order it should read it. */
export function briefUserContent(workspace: BriefWorkspace, inputs: BriefInputs): string {
  const timezone = workspace.timezone || "America/New_York";
  const today = new Date().toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" });
  const brief = String(workspace.client_brief ?? "").trim();
  const section = (channel: BriefInputs["internal"], label: string) => {
    if (!channel.channelId) return `# The ${label} channel\n\nNo ${label} channel is configured for this client.`;
    if (channel.error) return `# The ${label} channel\n\nThis channel could not be read: ${channel.error}\nSay so in one line at the end of the brief.`;
    if (!channel.messages) return `# The ${label} channel\n\nNothing has been said in this channel in the last ${BRIEF_WINDOW_DAYS} days.`;
    return `# The ${label} channel (last ${BRIEF_WINDOW_DAYS} days, ${channel.messages} messages)\n\n${channel.text}`;
  };
  /**
   * The call, with its age stated in words rather than left for the model to work out from a date.
   *
   * The age is the whole difference between "we agreed this on Friday and it is now Monday" and "we
   * agreed this three weeks ago and it never happened". A brief that treats a stale call as current
   * nags about work that has since been renegotiated, which is exactly how it gets muted.
   */
  const callSection = (() => {
    const call = inputs.call;
    if (!call) return `# The last call\n\n${inputs.callReason || "No transcript of a recent call with this client was available."}\nDo not speculate about what was discussed. If nothing else in the brief depends on it, do not mention it at all.`;
    const when = call.ageDays === null ? "at an unknown date" : call.ageDays === 0 ? "today" : call.ageDays === 1 ? "yesterday" : `${call.ageDays} days ago`;
    const stale = call.ageDays !== null && call.ageDays > 10
      ? ` This is over a week old, so treat anything agreed on it as possibly superseded by the channels above.`
      : "";
    const cut = call.truncated ? "\n\nOnly the last part of the transcript is included; the earlier portion was too long to pass on." : "";
    return [
      `# The last call: "${call.title}", ${when}${stale}`,
      call.summary ? `## Granola's own summary\n\n${call.summary}` : "",
      call.transcript ? `## Transcript\n\nA machine transcription, so names and product terms are unreliable. Commitments the agency made here are the highest-value thing in this brief.${cut}\n\n${call.transcript}` : "The transcript itself could not be read, so only the summary above is available.",
    ].filter(Boolean).join("\n\n");
  })();

  return [
    `# Client\n\n${workspace.name}. Today is ${today} in ${timezone}.`,
    `# Figures\n\nThese are facts. Do not restate them differently and do not compute new ones.\n\n${signalsAsText(inputs.signals)}`,
    section(inputs.internal, "internal"),
    section(inputs.external, "external"),
    callSection,
    // Last, and trimmed: the brief is thousands of words of standing context, and it is the least
    // time-sensitive thing here. It is included because it is the only place an expectation like
    // "should be running three campaigns" is written down.
    brief ? `# Client brief\n\nStanding context. Anything in here that states what this account is supposed to be doing counts as an expectation the figures above can be measured against.\n\n${brief.slice(0, 8_000)}` : "",
  ].filter(Boolean).join("\n\n---\n\n");
}

/**
 * ── The trace: what one run actually did ────────────────────────────────────────────────────────
 *
 * "Generate" reaches four systems, and any of them can come back thin without anything looking wrong: a
 * bot nobody invited to the channel, a key that cannot see this week's call, a HeyReach sync that stopped
 * on Tuesday. The brief says what it was missing in one line, which is right for a Slack message and no
 * use at all for working out why. This is the other half — every request made, what came back, and the
 * first part of the text verbatim, so a thin brief can be traced to the source that was thin.
 *
 * Built after the run from the same inputs the model was given, rather than recorded as the run goes. That
 * is the whole reason it can be trusted: there is no second set of instrumentation to keep in step, and
 * nothing here can claim a source the brief did not actually use.
 */
export type TraceStep = {
  /** The system that was asked, as the shortest thing that names it. */
  source: string;
  /** One line: what was asked for and what came back. */
  result: string;
  /** `partial` is its own state because two of these sources are routinely half-there. */
  state: "ok" | "partial" | "missing";
  /** The figures behind the line above, one short line each. */
  facts: string[];
  /** What was handed on, verbatim and cut to length, with the full size stated. */
  excerpts: Array<{ label: string; chars: number; text: string }>;
};

/** What the model call and the send did, which is only known once both have happened. */
export type BriefOutcome = {
  model: string;
  promptChars: number;
  contentChars: number;
  briefChars: number;
  destination: string;
  channelId: string;
  posted: boolean;
  sendError?: string;
};

/** Long enough to recognise what was read, short enough to scroll past. */
const EXCERPT_CHARS = 1_400;

const excerptOf = (label: string, body: string) => ({ label, chars: body.length, text: body.slice(0, EXCERPT_CHARS).trim() });
const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;

export function briefTrace(workspace: BriefWorkspace, inputs: BriefInputs, outcome: BriefOutcome): TraceStep[] {
  const timezone = workspace.timezone || "America/New_York";
  const steps: TraceStep[] = [];

  // 1 — Slack. Both channels in one step, because "we read the channels" is one act and a client with no
  // external channel is the normal case rather than a failure worth its own line.
  {
    const both: Array<[string, BriefChannel]> = [["Internal", inputs.internal], ["External", inputs.external]];
    const facts: string[] = [];
    let read = 0;
    let raw = 0;
    for (const [label, channel] of both) {
      if (!channel.channelId) {
        facts.push(`${label}: no channel is configured.`);
        continue;
      }
      if (channel.error) {
        facts.push(`${label} ${channel.channelId}: could not be read — ${channel.error}`);
        continue;
      }
      read += 1;
      raw += channel.raw ?? channel.messages;
      const skipped = (channel.raw ?? channel.messages) - channel.messages;
      facts.push(`${label} ${channel.channelId}: ${plural(channel.messages, "message")} over ${BRIEF_WINDOW_DAYS} days${skipped > 0 ? `, ${count(skipped)} dropped as joins or empty` : ""}.`);
      if (channel.capped) facts.push(`${label} hit the ${count(BRIEF_MAX_MESSAGES)}-message ceiling, so the oldest of the window was not read.`);
    }
    const used = inputs.internal.messages + inputs.external.messages;
    const excerpts: TraceStep["excerpts"] = [];
    if (inputs.internal.text) excerpts.push(excerptOf("Internal channel, as the model read it", inputs.internal.text));
    if (inputs.external.text) excerpts.push(excerptOf("External channel, as the model read it", inputs.external.text));
    steps.push({
      source: "Slack channels",
      result: read
        ? `Pulled ${read === 2 ? "both channels" : "one channel"} and got ${plural(raw, "message")}. ${count(used)} carried text and went to the model.`
        : "No channel could be read, so nothing anyone said this week is in this brief.",
      state: read === 2 ? "ok" : read ? "partial" : "missing",
      facts,
      excerpts,
    });
  }

  // 2 — Granola. The one source whose absence is routine and whose absence must still be legible.
  {
    const call = inputs.call;
    if (!call) {
      steps.push({
        source: "Granola",
        result: inputs.callReason || "No transcript of a recent call with this client was available.",
        state: "missing",
        facts: [`Searched the last ${CALL_WINDOW_DAYS} days of every stored key by meeting title.`],
        excerpts: [],
      });
    } else {
      const on = call.startedAt
        ? new Date(call.startedAt).toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" })
        : "";
      const age = call.ageDays === null ? "" : call.ageDays === 0 ? "today" : call.ageDays === 1 ? "yesterday" : `${call.ageDays} days ago`;
      const attendees = call.attendees ?? [];
      const facts = [`Found in ${call.owner}'s Granola, out of every stored key.`];
      facts.push(attendees.length ? `${plural(attendees.length, "attendee")}: ${attendees.join(", ")}.` : "The note carried no attendee list.");
      if (call.durationMinutes) facts.push(`Scheduled for ${plural(call.durationMinutes, "minute")}.`);
      facts.push(call.transcript
        ? `Transcript: ${plural(call.transcript.length, "character")}${call.truncated ? ", of which only the last part was sent — the end of a call is where next steps get agreed" : ", sent whole"}.`
        : "The transcript could not be read, so only Granola's own summary was sent.");
      const excerpts: TraceStep["excerpts"] = [];
      if (call.summary) excerpts.push(excerptOf("Granola's own summary", call.summary));
      if (call.transcript) excerpts.push(excerptOf("Transcript, as the model read it", call.transcript));
      steps.push({
        source: "Granola",
        result: `Found “${call.title}”${on ? `, ${on}` : ""}${age ? ` (${age})` : ""}.`,
        state: call.transcript ? "ok" : "partial",
        facts,
        excerpts,
      });
    }
  }

  // 3 — HeyReach. Every campaign the model was given, in full, because the figures are the part of a
  // brief nobody checks and the only way to check them is to see the same numbers the model saw.
  {
    const { campaigns, sending, replies, acceptance, staleness } = inputs.signals;
    const facts: string[] = [];
    for (const campaign of campaigns.names) {
      const accepted = rate(campaign.accepted, campaign.sent);
      facts.push(`“${campaign.name}” (${campaign.status}): ${count(campaign.sent)} sent, ${count(campaign.accepted)} accepted${accepted === null ? "" : ` (${accepted}%)`}, ${count(campaign.replies)} replies, ${count(campaign.pending)} not yet contacted.`);
    }
    const untold = campaigns.total - campaigns.names.length;
    if (untold > 0) facts.push(`${plural(untold, "smaller campaign")} were left out, to keep the prompt to the ones with volume in them.`);
    facts.push(`Connection requests: ${count(sending.thisWeek)} this week against ${count(sending.lastWeek)} the week before${sending.changePercent === null ? "" : ` (${sending.changePercent > 0 ? "+" : ""}${sending.changePercent}%)`}.`);
    facts.push(`Replies: ${count(replies.thisWeek)} this week against ${count(replies.lastWeek)} the week before.`);
    if (acceptance.thisWeek !== null) facts.push(`Acceptance: ${acceptance.thisWeek}%${acceptance.lastWeek === null ? "" : ` against ${acceptance.lastWeek}% the week before`}.`);
    if (!sending.lastDayWithSends) facts.push("No sending at all is on record for the last three weeks.");
    else if (sending.quietDays >= 2) facts.push(`Nothing sent since ${sending.lastDayWithSends} — ${plural(sending.quietDays, "day")} quiet.`);
    if (staleness.statsAgeHours !== null) facts.push(`Campaign figures were last collected ${plural(staleness.statsAgeHours, "hour")} ago.`);
    const known = Boolean(campaigns.total || staleness.dayCount);
    steps.push({
      source: "HeyReach",
      result: known
        ? `Read ${plural(campaigns.total, "campaign")} and ${plural(staleness.dayCount, "day")} of daily figures — ${campaigns.active} active, ${campaigns.paused} paused or stopped.`
        : "No figures have ever been collected for this client, so the brief was told to report none.",
      // Stale figures are the failure that looks like success, so they are not allowed to read as `ok`.
      state: !known ? "missing" : staleness.statsAgeHours !== null && staleness.statsAgeHours > 36 ? "partial" : "ok",
      facts,
      excerpts: [],
    });
  }

  // 4 — The model. Stated as a count of live sources, because "two of three" is the fact that explains a
  // brief which reads thin, and it is the one thing the brief itself cannot say convincingly about itself.
  {
    const live = [
      Boolean(inputs.internal.messages || inputs.external.messages),
      Boolean(inputs.call),
      Boolean(inputs.signals.campaigns.total || inputs.signals.staleness.dayCount),
    ].filter(Boolean).length;
    steps.push({
      source: "Anthropic",
      result: `Fed ${live} of 3 sources to ${outcome.model} and got ${plural(outcome.briefChars, "character")} back.`,
      state: live === 3 ? "ok" : live ? "partial" : "missing",
      facts: [
        `Instructions: ${plural(outcome.promptChars, "character")}.`,
        `Everything above as one message: ${plural(outcome.contentChars, "character")}.`,
        "Every figure in the brief was computed here and handed over as fact. The model was not asked to count anything.",
      ],
      excerpts: [],
    });
  }

  // 5 — The send. A preview is a finished run, not an abandoned one, so it gets a line rather than nothing.
  {
    const preview = outcome.destination === "preview";
    steps.push({
      source: "Slack post",
      result: preview
        ? "Nothing was posted. This run was a preview, so the brief exists only on this page."
        : outcome.posted
          ? `Posted to ${outcome.channelId} as QC Bot.`
          : `Slack refused the message: ${outcome.sendError || "no reason given"}.`,
      state: preview || outcome.posted ? "ok" : "missing",
      facts: preview ? [] : [`Destination: the ${outcome.destination} channel.`],
      excerpts: [],
    });
  }

  return steps;
}
