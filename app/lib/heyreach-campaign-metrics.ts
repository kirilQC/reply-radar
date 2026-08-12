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
 * Replies and sentiment are deliberately *not* taken from here. HeyReach counts a reply when a message
 * comes back; we count one when it lands in our tables and gets a sentiment. Those disagree, and a
 * report whose headline reply count cannot be divided by its own denominator is worse than one with a
 * slightly conservative denominator. So: HeyReach supplies sent and accepted, our tables supply replies.
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
   * Mean of each campaign's own acceptance rate, not the pooled total.
   *
   * Asked for as an average, and it is the fairer figure when campaigns differ wildly in size — a
   * pooled rate lets one 3,000-lead campaign speak for all of them.
   */
  acceptanceRate: number;
  rows: CampaignFunnelRow[];
};

export const emptyFunnel = (reason: string): CampaignFunnel => ({
  available: false,
  reason,
  campaignCount: 0,
  connectionsSent: 0,
  connectionsAccepted: 0,
  acceptanceRate: 0,
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
      };
    });

  // Campaigns that sent nothing in the period are excluded from the average rather than counted as 0%,
  // which would drag the figure down with campaigns that never ran.
  const rated = parsed.filter((row) => row.connectionsSent > 0);

  return {
    available: true,
    reason: "",
    campaignCount: parsed.length,
    connectionsSent: parsed.reduce((total, row) => total + row.connectionsSent, 0),
    connectionsAccepted: parsed.reduce((total, row) => total + row.connectionsAccepted, 0),
    acceptanceRate: rated.length ? rated.reduce((total, row) => total + row.acceptanceRate, 0) / rated.length : 0,
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
    const response = await fetch(`${API_BASE.replace(/\/$/, "")}/stats/GetOverallStatsByCampaign`, {
      method: "POST",
      headers: { "X-API-KEY": key, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ accountIds: [], campaignIds: ids, startDate: since, endDate: until }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

/**
 * Joins the HeyReach funnel to the replies we hold, producing the figures the report prints.
 *
 * Both rates divide by connections accepted — the number of people who could actually be messaged.
 * Dividing by requests sent would understate the work, and dividing by leads on the list would compare
 * replies against people who were never reached.
 */
export function reportMetrics(
  funnel: CampaignFunnel,
  replies: { total: number; positive: number; leadsReplied: number },
) {
  const accepted = funnel.connectionsAccepted;
  return {
    available: funnel.available,
    reason: funnel.reason,
    campaignCount: funnel.campaignCount,
    connectionsSent: funnel.connectionsSent,
    connectionsAccepted: accepted,
    acceptanceRate: funnel.acceptanceRate,
    replies: replies.total,
    positiveReplies: replies.positive,
    leadsReplied: replies.leadsReplied,
    replyRate: accepted ? (replies.total / accepted) * 100 : 0,
    positiveReplyRate: accepted ? (replies.positive / accepted) * 100 : 0,
    campaigns: funnel.rows,
  };
}

export type ReportMetrics = ReturnType<typeof reportMetrics>;
