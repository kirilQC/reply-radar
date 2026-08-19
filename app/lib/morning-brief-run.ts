// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The three parts of a morning brief that reach outside the process: the stored prompt, the Slack
 * channels, and Anthropic.
 *
 * Split from `morning-brief.ts` so that file has no relative imports at all. That is not tidiness — it
 * is what lets the tests import the arithmetic and run it, and the arithmetic is the part of a brief
 * that has to be right. A test that had to reach a Slack token to check a percentage would not be
 * written, and then the percentage would go unchecked.
 */

import {
  BRIEF_MAX_MESSAGES,
  BRIEF_WINDOW_DAYS,
  CALL_WINDOW_DAYS,
  DEFAULT_MORNING_BRIEF_PROMPT,
  morningBriefPromptKey,
  type BriefInputs,
  type BriefWorkspace,
  type CampaignFacts,
  type LiveFigures,
  type PriorBrief,
  type PriorBriefReply,
} from "./morning-brief";
import { localDayKey } from "./morning-brief-schedule";
import { channelHistory, resolveUserNames, threadReplies, transcript } from "./slack";
import { findClientCalls, type ClientCall, type GranolaKey } from "./granola";
import { ALL_STATUSES, campaignStatusFor } from "./heyreach-campaigns";
import { campaignFunnelFor, dailyStatsFor } from "./heyreach-campaign-metrics";
import { readConfig } from "./app-config";

/** Exported so the trace can name the model that was actually asked, rather than a second copy of it. */
export const BRIEF_MODEL = "claude-sonnet-4-6";
/**
 * A brief is 200–450 words by design, so this is headroom rather than a target. It has to be headroom:
 * a brief cut off mid-sentence loses the last action item, and the last one is the one nobody else knew
 * about. Raised from 1,400 when the brief grew a per-campaign HeyReach section and owned action items.
 */
const MAX_OUTPUT_TOKENS = 2_000;
/**
 * Inside Hobby's 60s function ceiling, with room for the two Granola calls that now run first and for
 * writing the row afterwards. Was 45s, which left nothing for the transcript fetch.
 */
const REQUEST_TIMEOUT_MS = 40_000;

type Row = Record<string, unknown>;

/** The stored instructions for this client, then the global ones, then the built-in default. */
export async function morningBriefPrompt(slug?: string | null): Promise<string> {
  const asText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const scoped = slug ? asText(await readConfig(morningBriefPromptKey(slug)).catch(() => "")) : "";
  if (scoped) return scoped;
  const global = asText(await readConfig(morningBriefPromptKey()).catch(() => ""));
  return global || DEFAULT_MORNING_BRIEF_PROMPT;
}

/**
 * Every string in a Postgres text array, deduplicated, blank entries dropped.
 *
 * Written defensively because the column is additive: a database that has not had the migration run
 * returns nothing at all for it, and PostgREST hands back `null` rather than an empty array.
 */
const asList = (value: unknown): string[] =>
  [...new Set((Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim()).filter(Boolean))];

/**
 * How many extra channels one brief will read.
 *
 * Each one is a `conversations.history` call plus a `conversations.replies` call per thread, and Slack rate
 * limits per method per workspace. Three is more than any client has needed and leaves the two channels
 * that matter with room to be read in full.
 */
const MAX_EXTRA_CHANNELS = 3;

/**
 * Reads both channels, or reports why it could not.
 *
 * A channel that cannot be read must not fail the brief. The commonest reason by far is that nobody
 * invited the bot, and a brief that says "the internal channel could not be read: the bot is not in
 * that channel" is what gets that fixed. A brief that fails silently, or fails entirely, does not.
 *
 * The internal and external channels are read as named things, and anything else the client has been given
 * is read afterwards into `extraChannels`. That split is kept all the way from the column names to the
 * prompt: the two named channels are where our team and the client respectively commit to things, and an
 * extra channel is somewhere a useful thing was mentioned once.
 */
export async function gatherChannels(workspace: BriefWorkspace): Promise<Pick<BriefInputs, "internal" | "external" | "extraChannels">> {
  const timezone = workspace.timezone || "America/New_York";
  const readChannel = async (channelId: string) => {
    if (!channelId) return { channelId: "", messages: 0, raw: 0, threads: 0, replies: 0, capped: false, text: "", people: [] };
    try {
      const history = await channelHistory(channelId, BRIEF_WINDOW_DAYS, BRIEF_MAX_MESSAGES);
      const names = await resolveUserNames(history.messages.map((message) => message.author));
      return {
        channelId,
        // Name and id together, so the brief can turn "Kori should do this" into a mention Kori is
        // actually notified by. Only the people who spoke, which is both all the model needs and the
        // reason it cannot ping somebody who was never in the conversation.
        people: [...names].map(([id, name]) => ({ id, name })),
        // Parents and replies together, because that is what the model is given. The two are reported
        // separately below so the trace can still say how much of it came out of threads.
        messages: history.messages.length,
        raw: history.raw,
        threads: history.threads,
        replies: history.replies,
        // Slack returned exactly as many as were asked for, which means there were probably more.
        capped: history.raw >= BRIEF_MAX_MESSAGES,
        text: transcript(history.messages, names, timezone),
      };
    } catch (error) {
      return { channelId, messages: 0, raw: 0, threads: 0, replies: 0, capped: false, text: "", people: [], error: error instanceof Error ? error.message : "This channel could not be read." };
    }
  };
  const named = [String(workspace.slack_internal_channel_id ?? "").trim(), String(workspace.slack_external_channel_id ?? "").trim()];
  // An extra channel that is already one of the two named ones is dropped rather than read twice. The
  // same conversation appearing under two headings would read to the model as two sources agreeing.
  const extraIds = asList(workspace.slack_extra_channel_ids).filter((id) => !named.includes(id)).slice(0, MAX_EXTRA_CHANNELS);
  const [internal, external, ...extraChannels] = await Promise.all([
    readChannel(named[0]),
    readChannel(named[1]),
    ...extraIds.map((id) => readChannel(id)),
  ]);
  return { internal, external, extraChannels };
}

/**
 * How many past briefs to read back in.
 *
 * Two, because on a three-a-week cadence the item somebody replied "resolved" to could have been in either
 * of the last two, and a reply often lands the morning after the brief rather than the same one. More than
 * two is a third page-long body in the prompt buying almost nothing: an item left genuinely outstanding for
 * a week is being carried by the channels and the figures as well, not by a brief from six sends ago.
 */
const PRIOR_BRIEF_COUNT = 2;

/**
 * The last one or two briefs this client got, and the replies the team left underneath them.
 *
 * This is the brief's memory of itself. The bodies come from `rr_slack_briefs`, which already stored them,
 * so the brief text costs no Slack call; only the replies are read live, one `conversations.replies` per
 * brief. A reply that closes an item is the team's own correction, and reading it back in is the whole
 * point — see the note on `threadReplies` and the prompt section in `briefUserContent`.
 *
 * Only briefs that were actually posted to the client's internal channel are considered: a preview has no
 * thread for anyone to reply in, and a failed send has no `slack_message_ts` to find replies by. Never
 * throws. An empty list is the ordinary answer for a client's first brief and for a workspace whose Slack
 * cannot be read, and neither is a reason to fail the brief being written now.
 */
export async function gatherPriorBriefs(
  read: (path: string) => Promise<unknown>,
  workspace: BriefWorkspace,
): Promise<PriorBrief[]> {
  const timezone = workspace.timezone || "America/New_York";
  try {
    const rows = await read(
      `rr_slack_briefs?select=body,created_at,slack_channel_id,slack_message_ts`
      + `&workspace_id=eq.${encodeURIComponent(workspace.id)}&automation=eq.morning_brief`
      + `&destination=eq.internal&status=eq.success&slack_message_ts=not.is.null`
      + `&order=created_at.desc&limit=${PRIOR_BRIEF_COUNT}`,
    ).catch(() => []);
    const briefs = (Array.isArray(rows) ? (rows as Row[]) : []).filter((row) => String(row.body ?? "").trim());
    const todayKey = localDayKey(new Date(), timezone);

    return await Promise.all(briefs.map(async (row): Promise<PriorBrief> => {
      const channelId = String(row.slack_channel_id ?? "").trim();
      const ts = String(row.slack_message_ts ?? "").trim();
      const messages = await threadReplies(channelId, ts);
      const names = await resolveUserNames(messages.map((message) => message.author));
      const replies: PriorBriefReply[] = messages
        .map((message) => ({ who: names.get(message.author) ?? message.author, text: message.text.replace(/\s+/g, " ").trim() }))
        .filter((reply) => reply.text);
      const created = new Date(String(row.created_at ?? ""));
      const valid = !Number.isNaN(created.getTime());
      return {
        postedOn: valid ? created.toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }) : "an earlier day",
        ageDays: valid ? Math.max(0, Math.round((Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${localDayKey(created, timezone)}T00:00:00Z`)) / 86_400_000)) : null,
        body: String(row.body ?? ""),
        replies,
      };
    }));
  } catch {
    return [];
  }
}

/**
 * How long the brief will wait on HeyReach.
 *
 * Shorter than the thirty seconds a client report allows, and for the opposite reason. A report is
 * generated by somebody sitting looking at it, who would rather wait than see a gap; a brief has sixty
 * seconds in total, forty of which belong to the model call that has to happen afterwards. HeyReach has
 * been measured at 26s on a cold start, so this is knowingly under that outlier: the run that hits one
 * falls back to the stored copy and says so, which is a worse brief than a slow one but a far better
 * outcome than no brief at all.
 */
const HEYREACH_TIMEOUT_MS = 12_000;

/**
 * How many days of day-by-day history to ask for.
 *
 * Two seven-day windows are compared, and the third week is asked for so that "nothing has been sent for
 * eleven days" is sayable rather than bottoming out at fourteen. The same span the overnight sync stores,
 * so live and stored runs describe the same stretch of time.
 */
const HEYREACH_HISTORY_DAYS = 21;

/**
 * The client's figures, from HeyReach, now.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────────────────────────
 * These figures used to be read out of `rr_campaign_stats` and `rr_daily_stats`, which a worker refreshes
 * one client per cycle at a day's cadence. That is right for the analytics pages, which say on their face
 * when the numbers were taken and have a button to take them again. It is wrong for the brief: a brief
 * states a pending-lead count and a days-of-sending-left as bare facts, three mornings a week, to people
 * who will act on them, and a day-old count of leads not yet contacted is wrong by a day of sending. The
 * team checked one against HeyReach's own screen and the two disagreed, which is exactly the event that
 * makes every other figure in the brief suspect.
 *
 * ── Three calls, all scoped to this client's own campaigns ────────────────────────────────────────
 * The campaign list decides which campaigns are ours (several clients ran their own outbound before the
 * engagement, on the same account behind the same key), and the other two are then narrowed to those ids.
 * The narrowing is not a nicety: an unscoped day series counts a client's own pre-engagement sending as
 * ours, which is its own way of reporting a busy week on an account where nothing of ours went out.
 *
 * Never throws. `available: false` with a reason is the answer when HeyReach cannot be reached, and the
 * caller then falls back to the stored copy with the brief saying so out loud.
 */
export async function gatherLiveFigures(apiKey: string): Promise<LiveFigures> {
  const key = String(apiKey ?? "").trim();
  const nothing = (reason: string): LiveFigures => ({ available: false, reason, campaigns: [], days: [] });
  if (!key) return nothing("");

  const status = await campaignStatusFor(key, ALL_STATUSES);
  if (!status.available) return nothing(status.reason);
  // A client with no campaigns of ours at all is a real answer, not a failure, and it is the one the brief
  // most needs to state plainly. Both narrowed calls below would read an empty id list as "the whole
  // account", so they are skipped rather than asked.
  if (!status.all.length) return { available: true, reason: "", campaigns: [], days: [] };

  const ids = status.all.map((row) => row.id).filter(Boolean);
  const until = new Date();
  const since = new Date(until.getTime() - (HEYREACH_HISTORY_DAYS - 1) * 86_400_000);
  const [funnel, days] = await Promise.all([
    // Pinned to 2020 rather than to the window: these are the lifetime totals the brief reports per
    // campaign, and HeyReach answers a rollup with no date range with nothing at all.
    campaignFunnelFor(key, ids, "2020-01-01T00:00:00.000Z", until.toISOString(), HEYREACH_TIMEOUT_MS),
    dailyStatsFor(key, ids, `${since.toISOString().slice(0, 10)}T00:00:00.000Z`, until.toISOString(), HEYREACH_TIMEOUT_MS),
  ]);
  /*
   * All three or none.
   *
   * A partial live read is the worst of the options available here. Without the rollup every campaign
   * reports 0 sent and 0 accepted; without the series the brief states that nothing has been sent in three
   * weeks. Both are confidently wrong in the direction that starts a conversation about a dead account,
   * and neither is distinguishable in the output from the truth. Falling back to the stored copy is a brief
   * whose numbers are a day old and which says so, which is a thing a reader can correct for.
   */
  if (!funnel.available) return nothing(funnel.reason || "HeyReach did not return the campaign totals.");
  if (!days) return nothing("HeyReach did not return the day by day sending.");
  const totals = new Map(funnel.rows.map((row) => [row.campaignId, row]));

  const campaigns: CampaignFacts[] = status.all.map((row) => {
    const total = totals.get(row.id);
    return {
      name: row.name,
      status: row.status || "unknown",
      // HeyReach's own status is not enough: it keeps a campaign IN_PROGRESS while leads already in the
      // sequence finish, so a campaign with nothing left to contact reports itself as running for weeks
      // after it stopped doing anything. See `resolveState` in `heyreach-campaigns.ts`.
      isActive: row.state === "active",
      sent: total?.connectionsSent ?? 0,
      accepted: total?.connectionsAccepted ?? 0,
      replies: total?.replies ?? 0,
      pending: row.progress.pending,
      // The top of the funnel and the campaign's start date, both straight from HeyReach so the timeline
      // in Airtable is dated by when the campaign actually went live rather than when a row was first written.
      total: row.progress.listSize,
      launchedAt: row.launchedAt,
      senders: row.senderNames,
      senderIds: row.senderIds,
    };
  });

  return { available: true, reason: "", campaigns, days };
}

/** Every stored Granola key. Read on each run so a key added minutes ago is used by the next brief. */
export async function granolaKeys(read: (path: string) => Promise<unknown>): Promise<GranolaKey[]> {
  const rows = await read("rr_granola_keys?select=id,label,api_key&order=created_at.asc").catch(() => []);
  return (Array.isArray(rows) ? (rows as Row[]) : [])
    .map((row) => ({ id: String(row.id ?? ""), label: String(row.label ?? ""), apiKey: String(row.api_key ?? "") }))
    .filter((key) => key.apiKey);
}

/**
 * The client's last call and any extra calls, or the reason there isn't one.
 *
 * Never throws. A missing transcript is one of three sources going quiet, and the brief is more useful
 * with two sources and a line saying what it is missing than not written at all.
 */
export async function gatherCalls(
  read: (path: string) => Promise<unknown>,
  workspace: BriefWorkspace,
): Promise<{ call: ClientCall | null; extras: ClientCall[]; callReason?: string; errors: string[] }> {
  try {
    const keys = await granolaKeys(read);
    const found = await findClientCalls(
      keys,
      workspace.granola_title_match,
      asList(workspace.granola_extra_title_matches),
      workspace.name,
      CALL_WINDOW_DAYS,
    );
    return { call: found.call, extras: found.extras, callReason: found.reason, errors: found.errors };
  } catch (error) {
    return { call: null, extras: [], callReason: error instanceof Error ? error.message : "The call transcript could not be read.", errors: [] };
  }
}

/** Calls Anthropic once and returns the brief. One call, because a brief is short by design. */
export async function writeBrief(systemPrompt: string, userContent: string, model = BRIEF_MODEL): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set, so no brief can be written.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Not zero: the same figures every Monday would otherwise produce nearly the same sentences, and
      // a brief that reads as boilerplate stops being read even when the contents changed.
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Anthropic refused the request: ${detail}`);
  }
  const text = Array.isArray(payload?.content)
    ? payload.content.filter((part: Row) => part?.type === "text").map((part: Row) => String(part.text ?? "")).join("").trim()
    : "";
  if (!text) throw new Error("Anthropic returned an empty brief.");
  return text;
}
