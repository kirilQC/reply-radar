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
 * ── Almost nothing is imported here, on purpose ──────────────────────────────────────────────────
 * Everything that touches Slack, Supabase or Anthropic lives in `morning-brief-run.ts`. This file is
 * arithmetic and wording, which means the tests can run it directly — and the arithmetic is the part
 * that has to be right, because a figure in a brief is read by the people least likely to check it.
 *
 * The one exception is `shared/sending-runway.mjs`, imported with its extension because Node's
 * TypeScript loader will not resolve an extensionless relative path. The alternative was writing the
 * per-sender send cap out a second time, and a brief that says "two days of sending left" while the
 * campaign report says four is how the team learns to ignore both.
 */

import { DAILY_CONNECTIONS_PER_SENDER, sendingDaysLeft } from "../../shared/sending-runway.mjs";

/** The global prompt, and one variant per client that overrides it. Mirrors the sentiment prompt. */
export const MORNING_BRIEF_PROMPT_PREFIX = "morning_brief_prompt";
export const morningBriefPromptKey = (slug?: string | null) =>
  slug ? `${MORNING_BRIEF_PROMPT_PREFIX}_${slug}` : MORNING_BRIEF_PROMPT_PREFIX;

/**
 * How far back the brief looks at Slack.
 *
 * A fortnight, not a week. A week was chosen so a Monday brief covered the week that just ended, and it
 * was wrong for the thing the brief is actually for: an item somebody agreed to nine days ago and has
 * not done is the most overdue thing on the account, and a seven-day window is precisely the window in
 * which it disappears. The same length as the call window, so a commitment made on the last call and the
 * conversation that followed it are both in view.
 */
export const BRIEF_WINDOW_DAYS = 14;

/**
 * How many of a channel's own messages to read. Slack's own per-request ceiling, so nothing in the
 * window is dropped by us — a channel busy enough to exceed this in a fortnight does not exist here.
 *
 * Thread replies are fetched separately and are not counted against this, which is the point: the
 * commitment is usually the fourth reply down, not the message that started it.
 *
 * Here rather than beside the fetch because the trace has to be able to say the cap was reached, and a
 * cap stated in one file and reported from another is a cap that eventually stops matching.
 */
export const BRIEF_MAX_MESSAGES = 1_000;

/**
 * How far back to look for a call. Longer than the Slack window on purpose: weeklies get moved, skipped
 * for a holiday, or held every other week, and the commitments made on the last one stand until the next
 * one happens. A fortnight finds the call that is still in force rather than only this week's.
 */
export const CALL_WINDOW_DAYS = 14;

/**
 * Days of sending left below which the brief stops reporting and starts asking for new campaigns.
 *
 * Two, because building a campaign is not a same-day job: a list has to be pulled, enriched, and the
 * copy written and approved. By the time the runway is at zero the gap is already unavoidable, so the
 * alarm has to sound while there is still a day of sending to build against.
 */
export const RUNWAY_ALARM_DAYS = 2;

export const DEFAULT_MORNING_BRIEF_PROMPT = `You are the delivery lead for one client of a B2B outbound growth agency. You are writing the brief that lands in the team's internal Slack channel first thing in the morning, three mornings a week. The people reading it ran this account last week and will run it today: they do not need to be told what outbound is, what the client sells, or what a connection request is.

The brief has one job: **make sure everybody knows what we owe this client, who owes it, and whether the client's outbound is going to keep running.** It is not a status report and it is not a recap of the dashboard. It is a list of the work that is outstanding, in the order it should be done.

You will be given, for one client:
- **Figures**, computed from the agency's own records. These are facts. Never restate a figure differently from how it is given, never compute a new one, and never estimate.
- **The internal channel**, where the team talks about this client. Every message of the last fortnight, with thread replies indented under the message they answer.
- **The external channel**, shared with the client, if there is one. Anything we said here we said to the client's face.
- **The last call**, the full transcript of the most recent call with this client, if there was one. This is where the agency states out loud what it will do next, so it is the strongest evidence of what was promised.
- **The client brief**, which may state what this account is supposed to be doing.

## Before you write a single action item: check whether it is already done

This is the rule that decides whether the brief is trusted. An item that has already been handled, raised again the next morning, teaches everybody reading that the brief does not know what is going on — and once they believe that, the real items go unread too.

So every candidate item gets checked twice, in this order:

1. **Against the Figures**, whenever the item is about a campaign, a sender, or leads. The Figures are the system of record — they are read straight out of HeyReach — and they outrank anybody's account of what they did. Specifically:
   - "add senders to campaign X" or "swap the senders on X" → the Figures list the senders on every campaign by name. If the people named are already on it, the item is done. If they are not, it is outstanding, *no matter who said they had done it*.
   - "launch X" or "turn X on" → the Figures give every campaign and its status. If X is there and active, it launched.
   - "load more leads into X" / "X is running dry" → the Figures give leads not yet contacted and days of sending left per campaign.
   - "pause X" / "stop X" → the Figures give the status.
   - A campaign that is not in the Figures at all has not been built yet. Say that plainly rather than guessing.
2. **Against the channels**, for everything else — the work with no HeyReach footprint: a document, a report, an answer to the client, an integration. Read the whole of both channels, thread replies included, up to the newest message. "done", "sent it over", "just pushed that", a link dropped in reply, is the work being finished. A thread is where that almost always lives, which is why it has to be read to the bottom.

What to do with the result:
- **Done: leave it out entirely.** Do not list it as complete, do not tick it, do not mention it in passing. The brief is only the work that is still outstanding. A list of finished items is exactly the block of text that makes the brief too long to read.
- **Outstanding: list it**, and say where it was agreed and when.
- **The channel says done and the Figures say otherwise: that is the most important line in the brief.** Put it in *Start here* with its owner, and say both sides in one sentence — what somebody said, and what HeyReach actually shows. Somebody believes this is handled and it is not.

## What to write

Write as much as the outstanding work needs and no more — usually 200 to 450 words. Lead with whatever would change what somebody does in the next hour. If there is genuinely nothing outstanding and the sending is healthy, say so in two lines and stop: padding a brief out is how it stops being read.

The brief is read on a phone, between meetings, by somebody who will give it fifteen seconds before deciding whether to read the rest. So it is never one block of text. Every section starts with its own heading line, exactly as written below, emoji and all, with a blank line before it. Every item under a heading is its own bullet on its own line. No paragraph anywhere in the brief runs past two lines.

Use these sections, in this order, and **drop entirely any section that has nothing real in it** — an empty heading is worse than no heading.

:rotating_light: *Start here*
At most three bullets, and only for things that are actually urgent today: a client waiting on an answer, sending about to run dry, a commitment already past its date, or something believed done that the Figures say is not. Get urgency from what was said, not from your own sense of importance — a date somebody named, a client asking twice, "before the end of the week" on the call. Anything raised here is *not repeated* lower down — it carries its owner's mention here and that is the only time it appears. A brief that says the same thing twice is a brief somebody stops reading halfway.

:clipboard: *What we owe them*
The outstanding action items that are not already in *Start here*, one bullet each, each with an owner. This is the core of the brief. Cover everything we said we would do and have not done, wherever we said it: on the call, in the external channel to the client, or to each other in the internal channel. Write each one as the actual piece of work, in the words the team would use for it — a campaign to launch, a campaign to revise, a new campaign to build, a lead list to pull, a list to enrich, an integration or reporting job, a question to answer. Not "follow up on the list discussion". Format each as:
• *The thing to do* — <@OWNER> — _where it was agreed, roughly when, and the date if one was named._

Work out the owner from what you were given: who volunteered on the call, who was asked in the channel and did not decline, who has been doing this kind of work for this client. If two people could own it, mention the likelier one and say in the italics that the other was also in the conversation. If nobody can be identified, write _owner not agreed_ — which is itself a finding worth reading, because unowned work is the work that does not happen.

:chart_with_upwards_trend: *HeyReach right now*
The client's sending, as it stands. One bullet per active campaign, each giving the campaign's full name, leads still to contact, days of sending left, and which senders are on it. Then one final bullet with the total days of sending left across all active campaigns. If the Figures say nothing is running, that is the first bullet and it is urgent. If the runway is under two days, or there are no active campaigns at all, say plainly that new campaigns need building now and what that means in practice — lists to pull, lists to enrich, copy to write — and mention who should do it if the channels or the call make that clear. This is the one part of the brief that is allowed to tell the team to do something nobody asked for, because running out of leads is always somebody's fault after the fact and never anybody's job before it.

:hourglass: *Waiting on the client*
Anything we asked the client, on the call or in the external channel, that they have not answered. One bullet each: what we asked, when, and whether we have chased it.

:mag: *Worth knowing*
At most two bullets, and only for a figure that changed enough to matter. Skip this section by default.

## Rules

- Every action item and every commitment must be attributable to something you were given. Say who said it and roughly when. If you cannot point at it, leave it out — an invented action item costs the brief more trust than a missed one.
- **Campaign names in full, always, exactly as the Figures spell them.** Write *BV007: ASCs v2*, never "BV007" and never "the ASCs campaign". The prefix on its own means nothing to the person reading — they cannot tell which campaign you mean, so the item cannot be acted on.
- Never invent a deadline. A deadline exists only if somebody stated one, or the client brief states one. "Should probably be done soon" is not a deadline and must not be written as one.
- The transcript is a machine transcription and misspells names and product terms. Do not quote a mangled word as though it were said that way, and do not build an action item on one word you cannot make sense of. Where a name is mangled, match it to the right person from the mention table and use their mention code.
- Never guess at why something happened. "Sends stopped on Wednesday" is useful. "Sends stopped on Wednesday, probably because of the LinkedIn limits" is not, unless somebody said so.
- Silence is a finding. A campaign nobody has touched since it was launched is worth a line.
- Do not thank anyone, do not encourage anyone, do not close with a summary or a question. End on the last finding.

## Formatting

- Slack mrkdwn, which is not markdown. *bold* with single asterisks. _italic_ with underscores. \`code\` with backticks. There is no underline in Slack — do not try.
- No markdown headings (\`#\`), no \`**double asterisks**\`, no tables, no code fences. They render as literal characters and make the brief look broken.
- Bullets with • at the start of the line. One item per line, never two joined by a semicolon.
- A blank line between every section, and between the section heading and its first bullet.
- **Mention people with their mention code from the mention table** — \`<@U04AB12CD>\` — so the owner of each item is actually notified. Copy the code exactly; a name typed as plain \`@kori\` is just text and reaches nobody. Anybody who is not in that table is written as plain text.
- Emoji in the section headings as given above, and sparingly elsewhere: one to mark something urgent or broken is useful, a decoration on every bullet is noise.`;

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

/** One campaign as the brief states it. `senders` are names where known, ids where not. */
export type BriefCampaign = {
  name: string;
  status: string;
  /** Whether this one is running, decided here so the prompt never has to read a status string. */
  isActive: boolean;
  sent: number;
  accepted: number;
  replies: number;
  pending: number;
  senders: string[];
  /** Days of sending left at this campaign's own sender count, or null when it has no senders. */
  daysLeft: number | null;
};

export type BriefSignals = {
  // `finished` is counted so that the three buckets add up to `total`. Without it a client whose work is
  // mostly done reads as "13 campaigns, 0 active, 2 paused", and the eleven unaccounted for look like a bug.
  campaigns: { total: number; active: number; paused: number; finished: number; names: BriefCampaign[] };
  /**
   * How long the client keeps sending if nothing new is built.
   *
   * Computed across every active campaign rather than summed per campaign, because senders are shared:
   * two campaigns on the same four accounts do not have four accounts each. Total pending divided by the
   * whole distinct sender capacity is the only figure that answers "when do we run dry?"
   *
   * This is the one number in the brief that is supposed to make somebody do something today, so it is
   * computed here and handed over as fact like every other figure.
   */
  runway: { daysLeft: number | null; pending: number; senders: number; needsCampaigns: boolean };
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
  const [campaignRows, dailyRows, senderRows] = await Promise.all([
    read(`rr_campaign_stats?select=name,status,connections_sent,connections_accepted,replies,leads_pending,sender_ids,refreshed_at&${filter}&order=connections_sent.desc&limit=60`),
    read(`rr_daily_stats?select=day,connections_sent,connections_accepted,replies&${filter}&sender_id=eq.&order=day.desc&limit=21`),
    // Per-sender rows exist only to put a name on the ids the campaign rows carry. A brief that says
    // "4 senders" is a statistic; one that says "Kori, Dan, Alina and Sam" is something a person can act
    // on, because knowing which account is oversubscribed is the whole reason to ask.
    read(`rr_daily_stats?select=sender_id,sender_name&${filter}&sender_id=neq.&order=day.desc&limit=400`),
  ]);
  const campaigns = Array.isArray(campaignRows) ? (campaignRows as Row[]) : [];
  const days = Array.isArray(dailyRows) ? (dailyRows as Row[]) : [];

  const senderNames = new Map<string, string>();
  for (const row of Array.isArray(senderRows) ? (senderRows as Row[]) : []) {
    const id = String(row.sender_id ?? "").trim();
    const name = String(row.sender_name ?? "").trim();
    if (id && name && !senderNames.has(id)) senderNames.set(id, name);
  }
  /** A campaign's assigned accounts, named where the daily figures have seen them. */
  const sendersOf = (row: Row) =>
    (Array.isArray(row.sender_ids) ? row.sender_ids : [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean);

  // HeyReach sends these as `IN_PROGRESS`, `PAUSED`, `FINISHED`, so the separator has to allow an
  // underscore — matching only "in progress" quietly filed every running campaign under none of these.
  const isActive = (status: unknown) => /active|running|in[ _-]?progress/i.test(String(status ?? ""));
  const isPaused = (status: unknown) => /pause|stopped|hold/i.test(String(status ?? ""));
  const isFinished = (status: unknown) => /finish|complet|done|ended/i.test(String(status ?? ""));

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

  // The runway is computed over every active campaign, not the ten reported below, and over the distinct
  // senders across all of them — two campaigns sharing four accounts have four between them, not eight.
  const running = campaigns.filter((row) => isActive(row.status));
  const runwayPending = running.reduce((total, row) => total + int(row.leads_pending), 0);
  const runwaySenders = new Set(running.flatMap(sendersOf)).size;
  const runwayDaysLeft = sendingDaysLeft(runwayPending, runwaySenders);

  return {
    campaigns: {
      total: campaigns.length,
      active: campaigns.filter((row) => isActive(row.status)).length,
      paused: campaigns.filter((row) => isPaused(row.status)).length,
      finished: campaigns.filter((row) => isFinished(row.status)).length,
      // Every active campaign, then the biggest of the rest up to ten. Volume alone was the wrong order:
      // a campaign switched on yesterday has sent almost nothing and is the one the team needs to hear
      // about, while the finished campaign at the top of the list changes nothing anybody does today.
      names: [...running, ...campaigns.filter((row) => !isActive(row.status))].slice(0, 10).map((row) => {
        const senders = sendersOf(row);
        return {
          name: String(row.name ?? ""),
          status: String(row.status ?? "unknown"),
          isActive: isActive(row.status),
          sent: int(row.connections_sent),
          accepted: int(row.connections_accepted),
          replies: int(row.replies),
          pending: int(row.leads_pending),
          senders: senders.map((id) => senderNames.get(id) || id),
          daysLeft: sendingDaysLeft(int(row.leads_pending), senders.length),
        };
      }),
    },
    runway: {
      daysLeft: runwayDaysLeft,
      pending: runwayPending,
      senders: runwaySenders,
      // Only claimed when there are campaign records to judge: a client whose HeyReach has never synced
      // has an unknown runway, and "start building campaigns" on the strength of no data is the kind of
      // wrong instruction that gets the whole brief ignored.
      needsCampaigns: campaigns.length > 0 && (runwayDaysLeft === null || runwayDaysLeft < RUNWAY_ALARM_DAYS),
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
  const { campaigns, runway, sending, replies, acceptance, staleness } = signals;

  // "Nothing has been collected" is the only case where the figures must be withheld, and it is not the
  // same as "no campaign row carried a timestamp": the daily figures are written by their own sync and
  // are perfectly good on their own. Gating on the timestamp suppressed a real week of sending.
  if (!campaigns.total && !staleness.dayCount) {
    lines.push("No figures have ever been collected for this client, so nothing below is known. Say so rather than reporting zeros.");
    return lines.join("\n");
  }
  if (staleness.statsAgeHours !== null && staleness.statsAgeHours > 36) lines.push(`These figures were last collected ${staleness.statsAgeHours} hours ago, so they may be behind.`);

  if (!campaigns.total) lines.push("No campaign records have been collected for this client, so which campaigns these figures came from is not known.");
  else lines.push(`Campaigns: ${campaigns.total} total, ${campaigns.active} active, ${campaigns.paused} paused, ${campaigns.finished} finished.`);
  if (campaigns.total && !campaigns.active) lines.push("No campaign is running for this client right now. Nothing new is going out until one is started.");
  for (const campaign of campaigns.names) {
    const accepted = rate(campaign.accepted, campaign.sent);
    const senders = campaign.senders.length
      ? `Senders on it: ${campaign.senders.join(", ")}.`
      : "No senders are recorded on it, so it may not be sending at all.";
    // Days left is stated only for the campaigns it means anything for. A paused or finished campaign has
    // a runway on paper and no runway in fact, and printing one invites the brief to count it.
    const left = !campaign.isActive
      ? ""
      : campaign.daysLeft === null
        ? " Days of sending left: unknown, because it has no senders."
        : campaign.daysLeft === 0
          ? " It has no leads left to contact, so it is done sending and needs new leads or replacing."
          : ` Days of sending left: ${campaign.daysLeft}, at ${DAILY_CONNECTIONS_PER_SENDER} connection requests per sender per day.`;
    lines.push(`- "${campaign.name}" (${campaign.status}${campaign.isActive ? ", active" : ""}): ${campaign.sent} sent, ${campaign.accepted} accepted${accepted === null ? "" : ` (${accepted}%)`}, ${campaign.replies} replies, ${campaign.pending} leads not yet contacted. ${senders}${left}`);
  }

  if (campaigns.active) {
    lines.push(`Across all ${campaigns.active} active campaigns: ${runway.pending} leads still to contact, ${runway.senders} distinct sender${runway.senders === 1 ? "" : "s"} between them.`);
    if (runway.daysLeft === null) lines.push("Total days of sending left cannot be worked out, because no senders are recorded on the active campaigns.");
    else lines.push(`Total days of sending left across all active campaigns: ${runway.daysLeft}.`);
  }
  if (runway.needsCampaigns) {
    lines.push(`This is under the ${RUNWAY_ALARM_DAYS}-day line. Tell the team, at the top of the brief, that new campaigns need building now: lists pulled, enriched, and copy written. Say who should do it if the channels or the call make that clear.`);
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
/**
 * ── Why Granola's own summary is not here ───────────────────────────────────────────────────────────
 * It used to be, and it made the brief worse. Granola's summary is already a model's reading of the call,
 * with its own idea of what mattered and its own omissions, and a summary sitting above a transcript gets
 * treated as the answer — the brief ended up paraphrasing Granola's conclusions rather than finding the
 * sentence where somebody said they would do something. The transcript alone is the only unmediated
 * record of what was actually said, so it is the only thing sent.
 */
export type BriefCall = {
  title: string;
  ageDays: number | null;
  owner: string;
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
  /** Everything sent to the model: the channel's own messages and every reply inside them. */
  messages: number;
  text: string;
  error?: string;
  /** What Slack returned before joins and empty messages were dropped. */
  raw?: number;
  /** Whether `BRIEF_MAX_MESSAGES` was reached, which means the oldest of the window is missing. */
  capped?: boolean;
  /** How many messages had a thread hanging off them, and how many replies were read out of those. */
  threads?: number;
  replies?: number;
  /**
   * Everybody who spoke, with the Slack id they speak as.
   *
   * Carried so the brief can write `<@U04AB12CD>` and have Slack render it as a real mention. The id is
   * the only way to do that — a mention typed as plain `@kori` is text, and the person it names never
   * finds out they were given an action item. Only people who appear in the transcript are here, which is
   * also the safety rail: the model cannot ping somebody it never saw.
   */
  people?: Array<{ id: string; name: string }>;
};

export type BriefInputs = {
  signals: BriefSignals;
  internal: BriefChannel;
  external: BriefChannel;
  /** Null when there was no call to find, or none could be read. `callReason` says which. */
  call?: BriefCall | null;
  callReason?: string;
};

/**
 * The one line that goes in the channel, with the brief itself hanging off it in a thread.
 *
 * The channel gets a date and a client and nothing else. That is the entire point of the split: a page of
 * brief posted three mornings a week buries every real conversation in the internal channel, whereas a
 * header everybody can skip and open when they need it costs one line. It says the brief is in the thread
 * because a bare header with no visible reply looks like the automation half-failed.
 */
export function briefHeaderText(workspace: BriefWorkspace, at: Date = new Date()): string {
  const timezone = workspace.timezone || "America/New_York";
  const date = at.toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" });
  return `:sunrise: *${workspace.name} — morning brief* · _${date}_\n:thread: The brief is in this thread.`;
}

/** What the model is shown, in the order it should read it. */
export function briefUserContent(workspace: BriefWorkspace, inputs: BriefInputs): string {
  const timezone = workspace.timezone || "America/New_York";
  const today = new Date().toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" });
  const brief = String(workspace.client_brief ?? "").trim();
  const section = (channel: BriefInputs["internal"], label: string) => {
    if (!channel.channelId) return `# The ${label} channel\n\nNo ${label} channel is configured for this client.`;
    if (channel.error) return `# The ${label} channel\n\nThis channel could not be read: ${channel.error}\nSay so in one line at the end of the brief.`;
    if (!channel.messages) return `# The ${label} channel\n\nNothing has been said in this channel in the last ${BRIEF_WINDOW_DAYS} days.`;
    // The thread count is stated because the shape of the transcript has to be explained once: replies are
    // indented under the message they answer, and a model told nothing about that reads them as new remarks.
    const threads = channel.threads ? `, including ${channel.replies ?? 0} replies across ${channel.threads} threads` : "";
    return `# The ${label} channel (last ${BRIEF_WINDOW_DAYS} days, every message${threads})\n\nIndented lines beginning ↳ are replies inside the thread on the message above them, in order. A reply is where the real answer usually is: the message that starts a thread asks, and the fourth reply down is where somebody agrees to do something.\n\n${channel.text}`;
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
      call.transcript
        ? `## Transcript, in full\n\nA machine transcription, so names and product terms are unreliable. This is the whole call and the only record of it you have — there is no summary, deliberately, because what you are looking for is the sentence in which somebody said they would do something, and who said it. Read it for that.${cut}\n\n${call.transcript}`
        : "The transcript could not be read, so nothing about what was said on this call is known. Do not speculate about it.",
    ].filter(Boolean).join("\n\n");
  })();

  /**
   * The mention roster: who spoke, and the code that mentions them.
   *
   * The brief names an owner on every action item, and a name in plain text is a name the owner never
   * sees. `<@U04AB12CD>` is the only form Slack notifies on, and there is no way to derive it from a
   * display name at write time — so the mapping is handed over as a table and the model is told to copy
   * it verbatim. Nobody outside this table can be mentioned, which is why the table is built from the
   * people who actually appear in the transcripts rather than from the whole workspace.
   */
  const roster = (() => {
    const byId = new Map<string, string>();
    for (const person of [...(inputs.internal.people ?? []), ...(inputs.external.people ?? [])]) {
      if (person.id && person.name && !byId.has(person.id)) byId.set(person.id, person.name);
    }
    if (!byId.size) return "";
    const lines = [...byId].map(([id, name]) => `- ${name} → <@${id}>`).join("\n");
    return `# How to mention people\n\nWhen the brief names somebody, write their mention code from this table exactly as it appears, including the angle brackets. Slack turns it into a real mention that notifies them; their name typed as plain text does not, and an owner who is not notified is an owner who does not know.\n\n${lines}\n\nAnybody not in this table is written as plain text — do not invent a mention code, and do not mention the client's own people even if they appear here.`;
  })();

  return [
    `# Client\n\n${workspace.name}. Today is ${today} in ${timezone}.`,
    `# Figures\n\nThese are facts. Do not restate them differently and do not compute new ones.\n\n${signalsAsText(inputs.signals)}`,
    roster,
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
      // `raw` counts only what `conversations.history` returned, so replies fetched from threads are not
      // part of it — which is why the arithmetic here is stated rather than left to be inferred from two
      // numbers that deliberately do not reconcile.
      const replies = channel.replies ?? 0;
      const skipped = (channel.raw ?? 0) - (channel.messages - replies);
      facts.push(`${label} ${channel.channelId}: ${plural(channel.messages - replies, "message")} over ${BRIEF_WINDOW_DAYS} days${skipped > 0 ? `, ${count(skipped)} dropped as joins or empty` : ""}.`);
      if (channel.threads) facts.push(`${label}: opened ${plural(channel.threads, "thread")} and read ${plural(replies, "reply", "replies")} out of them.`);
      if (channel.capped) facts.push(`${label} hit the ${count(BRIEF_MAX_MESSAGES)}-message ceiling, so the oldest of the window was not read.`);
    }
    const used = inputs.internal.messages + inputs.external.messages;
    const threads = (inputs.internal.threads ?? 0) + (inputs.external.threads ?? 0);
    const excerpts: TraceStep["excerpts"] = [];
    if (inputs.internal.text) excerpts.push(excerptOf("Internal channel, as the model read it", inputs.internal.text));
    if (inputs.external.text) excerpts.push(excerptOf("External channel, as the model read it", inputs.external.text));
    steps.push({
      source: "Slack channels",
      result: read
        ? `Pulled ${read === 2 ? "both channels" : "one channel"} and got ${plural(raw, "message")}, then opened ${plural(threads, "thread")}. ${count(used)} messages and replies went to the model.`
        : "No channel could be read, so nothing anyone said in the last fortnight is in this brief.",
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
        : "The transcript could not be read, so nothing from this call reached the brief.");
      facts.push("Granola's own summary was not sent. The transcript is the only account of the call the brief was given.");
      const excerpts: TraceStep["excerpts"] = [];
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
    const { campaigns, runway, sending, replies, acceptance, staleness } = inputs.signals;
    const facts: string[] = [];
    for (const campaign of campaigns.names) {
      const accepted = rate(campaign.accepted, campaign.sent);
      const senders = campaign.senders.length ? ` Senders: ${campaign.senders.join(", ")}.` : " No senders recorded.";
      const left = campaign.isActive && campaign.daysLeft !== null ? ` ${plural(campaign.daysLeft, "day")} of sending left.` : "";
      facts.push(`“${campaign.name}” (${campaign.status}): ${count(campaign.sent)} sent, ${count(campaign.accepted)} accepted${accepted === null ? "" : ` (${accepted}%)`}, ${count(campaign.replies)} replies, ${count(campaign.pending)} not yet contacted.${senders}${left}`);
    }
    const untold = campaigns.total - campaigns.names.length;
    if (untold > 0) facts.push(`${plural(untold, "smaller campaign")} were left out, to keep the prompt to the active ones and the ones with volume in them.`);
    if (campaigns.active) {
      facts.push(`Runway: ${count(runway.pending)} leads pending across ${plural(campaigns.active, "active campaign")} on ${plural(runway.senders, "sender")} — ${runway.daysLeft === null ? "days left unknown, because no senders are recorded" : `${plural(runway.daysLeft, "day")} of sending left`}.`);
    }
    // The one figure in the brief that is meant to start work today, so the trace has to show whether it
    // fired and on what basis. A brief that failed to raise it is a brief nobody can tell was wrong.
    if (runway.needsCampaigns) facts.push(`Under the ${RUNWAY_ALARM_DAYS}-day line, so the brief was told to ask for new campaigns to be built.`);
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
        ? `Read ${plural(campaigns.total, "campaign")} and ${plural(staleness.dayCount, "day")} of daily figures — ${campaigns.active} active, ${campaigns.paused} paused, ${campaigns.finished} finished.`
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
          ? `Posted to ${outcome.channelId} as QC Bot: a header in the channel, the brief in its thread.`
          : `Slack refused the message: ${outcome.sendError || "no reason given"}.`,
      state: preview || outcome.posted ? "ok" : "missing",
      facts: preview ? [] : [`Destination: the ${outcome.destination} channel.`],
      excerpts: [],
    });
  }

  return steps;
}
