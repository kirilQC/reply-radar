// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { heyreachFetch } from "../../shared/heyreach-throttle.mjs";

/**
 * The outbound funnel — requests sent, requests accepted, and the rates that follow from them.
 *
 * Separate from `heyreach-campaigns.ts` on purpose. That file answers "what is running?" from
 * `/campaign/GetAll`; this one answers "how did it perform?" from `/stats/GetOverallStatsByCampaign`.
 * Different endpoint, different shape, and only this one takes a date range.
 *
 * ── Scoped to the selected campaigns ────────────────────────────────────────────────────────────
 * The rates are computed across only the campaigns the report actually names. This is the whole reason
 * the figures are worth printing: a client reading "38% acceptance" next to three campaigns expects
 * that number to describe those three, not to be diluted by thirty paused campaigns from last year.
 * HeyReach filters server-side on `campaignIds`, so the scoping is exact rather than approximated
 * after the fact.
 *
 * Replies are HeyReach's too. Reports used to count inbound messages in our own tables, which never
 * matched the "Replied leads" a client or teammate sees in HeyReach (a lead who writes three messages is
 * three of ours and one of theirs). Every figure a report prints next to HeyReach's must be HeyReach's:
 * sent, accepted, leads messaged and leads replied all come from here. Only sentiment is ours, counted
 * per lead so it sits under the replied-lead count it is a share of.
 */

type Row = Record<string, unknown>;

const API_BASE = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";
/** Matches the campaign-list timeout: the same service cold-starts, and has been measured at 26s. */
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 60_000;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const count = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export type CampaignFunnelRow = {
  campaignId: string;
  name: string;
  connectionsSent: number;
  connectionsAccepted: number;
  /** Percent, 0-100. HeyReach's own figure where it gives one, else accepted ÷ sent. */
  acceptanceRate: number;
  /**
   * Replies as HeyReach counts them, messages and InMails together.
   *
   * Carried but deliberately unused by `reportMetrics` — see the note at the top of this file about why a
   * client report divides our own reply count by our own denominator. The morning brief is the other case:
   * it is read by the team, three mornings a week, next to HeyReach's own screen, and a reply count that
   * disagrees with what they can see there is the thing that stops the brief being trusted.
   */
  replies: number;
  /** Leads messaged (HeyReach's "Messaged leads"), messages and InMails together. */
  messagesStarted: number;
};

export type CampaignFunnel = {
  /** False means we could not ask. No rate below should then be printed as zero. */
  available: boolean;
  reason: string;
  /** How many campaigns the figures cover, so the report can say what "average" averages over. */
  campaignCount: number;
  connectionsSent: number;
  connectionsAccepted: number;
  /**
   * Accepted over sent across the campaigns, pooled, which is the figure HeyReach's dashboard shows for
   * the same campaigns and dates. It used to be a mean of per-campaign rates, which nobody could check.
   */
  acceptanceRate: number;
  /** Replied leads across the campaigns, as HeyReach counts them. */
  replies: number;
  /** Leads messaged across the campaigns, the reply rate's denominator in HeyReach. */
  messagesStarted: number;
  rows: CampaignFunnelRow[];
};

export const emptyFunnel = (reason: string): CampaignFunnel => ({
  available: false,
  reason,
  campaignCount: 0,
  connectionsSent: 0,
  connectionsAccepted: 0,
  acceptanceRate: 0,
  replies: 0,
  messagesStarted: 0,
  rows: [],
});

/** HeyReach returns acceptance as a 0-1 fraction; older rows have been seen to return a percent. */
const asPercent = (value: unknown, accepted: number, sent: number) => {
  const provided = Number(value);
  if (text(value) && Number.isFinite(provided)) return provided <= 1 ? provided * 100 : provided;
  return sent ? (accepted / sent) * 100 : 0;
};

/** Sorts a raw `overallStats` payload into the funnel. Split out so it is testable without a key. */
export function summariseFunnel(rows: unknown[]): CampaignFunnel {
  const parsed: CampaignFunnelRow[] = (Array.isArray(rows) ? rows : [])
    .map(object)
    .filter((row) => text(row.campaignId) || text(row.campaignName))
    .map((row) => {
      const sent = count(row.connectionsSent);
      const accepted = count(row.connectionsAccepted);
      return {
        campaignId: text(row.campaignId),
        name: text(row.campaignName) || `Campaign ${text(row.campaignId)}`,
        connectionsSent: sent,
        connectionsAccepted: accepted,
        acceptanceRate: asPercent(row.connectionAcceptanceRate, accepted, sent),
        replies: count(row.totalMessageReplies) + count(row.totalInmailReplies),
        messagesStarted: count(row.totalMessageStarted) + count(row.totalInmailStarted),
      };
    });

  const sum = (pick: (row: CampaignFunnelRow) => number) => parsed.reduce((total, row) => total + pick(row), 0);
  const sent = sum((row) => row.connectionsSent);
  const accepted = sum((row) => row.connectionsAccepted);
  return {
    available: true,
    reason: "",
    campaignCount: parsed.length,
    connectionsSent: sent,
    connectionsAccepted: accepted,
    acceptanceRate: sent ? (accepted / sent) * 100 : 0,
    replies: sum((row) => row.replies),
    messagesStarted: sum((row) => row.messagesStarted),
    rows: parsed.sort((a, b) => b.connectionsAccepted - a.connectionsAccepted),
  };
}

const cache = new Map<string, { expires: number; funnel: CampaignFunnel }>();

/**
 * Fetches the funnel for a set of campaigns over a window. Never throws — a report whose rates are
 * missing still has to render, saying the rates are missing.
 *
 * An empty `campaignIds` means the caller narrowed the report down to no campaigns at all, which makes
 * every rate undefined rather than zero. HeyReach would read `[]` as "all campaigns" and answer with
 * figures for the whole account, which is the one wrong answer available here.
 */
export async function campaignFunnelFor(
  apiKey: string,
  campaignIds: string[],
  since: string,
  until: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<CampaignFunnel> {
  const key = text(apiKey);
  if (!key) return emptyFunnel("No HeyReach API key is saved for this client.");
  if (!campaignIds.length) return emptyFunnel("No campaigns were selected, so there are no rates to report.");

  const ids = campaignIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  if (!ids.length) return emptyFunnel("The selected campaigns have no HeyReach ids.");

  const cacheKey = `${key}:${ids.sort((a, b) => a - b).join(",")}:${since}:${until}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.funnel;

  try {
    const response = await heyreachFetch(key, `${API_BASE.replace(/\/$/, "")}/stats/GetOverallStatsByCampaign`, {
      method: "POST",
      headers: { "X-API-KEY": key, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ accountIds: [], campaignIds: ids, startDate: since, endDate: until }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HeyReach campaign stats returned ${response.status}`);
    const payload = object(await response.json().catch(() => ({})));
    const funnel = summariseFunnel(Array.isArray(payload.overallStats) ? payload.overallStats : []);
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, funnel });
    return funnel;
  } catch (error) {
    return emptyFunnel(error instanceof Error ? error.message : "HeyReach could not be reached.");
  }
}

/** One day of the account's sending, as HeyReach reports it. */
export type DailyStat = { day: string; sent: number; accepted: number; replies: number };

/**
 * `byDayStats` sorted into a series, newest first.
 *
 * HeyReach keys it by timestamp and only writes a key for a day something happened, so a gap is a day
 * with no sending and must stay a gap — filling it with a zero row would make "nothing has been sent for
 * five days" indistinguishable from "five days were collected and four of them were quiet".
 */
export function summariseDailyStats(payload: unknown): DailyStat[] {
  const byDay = object(object(payload).byDayStats);
  const days: DailyStat[] = [];
  for (const [stamp, value] of Object.entries(byDay)) {
    const day = text(stamp).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const row = object(value);
    days.push({
      day,
      sent: count(row.connectionsSent),
      accepted: count(row.connectionsAccepted),
      replies: count(row.totalMessageReplies) + count(row.totalInmailReplies),
    });
  }
  return days.sort((a, b) => b.day.localeCompare(a.day));
}

/**
 * The account's day-by-day sending over a window, narrowed to a set of campaigns.
 *
 * Narrowed deliberately. Several clients ran their own outbound before the engagement, on the same
 * account behind the same key, and an unscoped series counts their sends as ours — which is how a brief
 * comes to report a week of sending on a client where nothing of ours went out at all.
 *
 * Never throws. An empty series is indistinguishable from a quiet fortnight, so the caller has to be
 * told the difference: `null` is "could not ask".
 */
export async function dailyStatsFor(
  apiKey: string,
  campaignIds: string[],
  since: string,
  until: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<DailyStat[] | null> {
  const key = text(apiKey);
  const ids = campaignIds.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  if (!key || !ids.length) return null;
  try {
    const response = await heyreachFetch(key, `${API_BASE.replace(/\/$/, "")}/stats/GetOverallStats`, {
      method: "POST",
      headers: { "X-API-KEY": key, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ accountIds: [], campaignIds: ids, startDate: since, endDate: until }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return summariseDailyStats(await response.json().catch(() => ({})));
  } catch {
    return null;
  }
}

/**
 * The figures a report prints, defined as HeyReach defines them.
 *
 * Replies are HeyReach's replied leads and the reply rate is replied leads over leads messaged, the same
 * division HeyReach's dashboard does. Positive is ours (HeyReach has no sentiment), counted per lead, and
 * its rate is a share of the replied leads. When HeyReach could not be asked, our own replied-lead count
 * stands in and the rates that need HeyReach's denominators read as unavailable.
 */
export function reportMetrics(
  funnel: CampaignFunnel,
  ours: { total: number; positive: number; leadsReplied: number },
) {
  const accepted = funnel.connectionsAccepted;
  const replies = funnel.available ? funnel.replies : ours.total;
  const leadsReplied = funnel.available ? funnel.replies : ours.leadsReplied;
  const messaged = funnel.messagesStarted || accepted;
  return {
    available: funnel.available,
    reason: funnel.reason,
    campaignCount: funnel.campaignCount,
    connectionsSent: funnel.connectionsSent,
    connectionsAccepted: accepted,
    leadsMessaged: funnel.messagesStarted,
    acceptanceRate: funnel.acceptanceRate,
    replies,
    positiveReplies: ours.positive,
    leadsReplied,
    replyRate: messaged ? (replies / messaged) * 100 : 0,
    positiveReplyRate: replies ? Math.min(100, (ours.positive / replies) * 100) : 0,
    campaigns: funnel.rows,
  };
}

export type ReportMetrics = ReturnType<typeof reportMetrics>;
