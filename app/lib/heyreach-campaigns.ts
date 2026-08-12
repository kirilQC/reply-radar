/**
 * Which of a client's HeyReach campaigns are running right now.
 *
 * Everything else in a report is derived from replies we have already stored, which means a campaign
 * only appears once somebody answers it. That is the wrong shape for the question a client actually
 * asks on a Friday — "what is live?" — because a campaign that is switched on and quiet looks
 * identical to one that was switched off a fortnight ago. The only place that distinction exists is
 * HeyReach, so it is fetched at report time.
 *
 * The key is per client (`rr_workspaces.heyreach_api_key_ciphertext`) and a HeyReach key is scoped to
 * the workspace it was issued for, so no separate workspace id is needed — the key *is* the scope.
 *
 * Failure is a first-class outcome here. A missing key or an unreachable HeyReach must leave the
 * report saying "status unknown" rather than "nothing is running", because those two read the same to
 * a client and only one of them is true.
 */

type Row = Record<string, unknown>;

const API_BASE = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";
const PAGE_SIZE = 100; // HeyReach caps a page at 100 records.
const PAGE_CEILING = 2_000; // Enough for any client we have; stops a broken totalCount looping forever.
/**
 * A page of 66 campaigns normally comes back in about a second, but the first call after a quiet
 * period has been seen to take 26 — HeyReach appears to cold-start. The timeout is set above that
 * outlier deliberately: a report that waits half a minute is annoying, one that tells a client
 * nothing is running because of a cold start is wrong.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Long enough that clicking Generate twice does not hit HeyReach twice, short enough that a campaign
 * switched on mid-session shows up. Report numbers are deliberately uncached; this is a courtesy to
 * someone else's rate limit, not a cache of the report.
 */
const CACHE_TTL_MS = 60_000;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const iso = (value: unknown) => {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};

export type CampaignState = "running" | "scheduled" | "paused" | "finished" | "draft" | "unknown";

export type CampaignStatusRow = {
  id: string;
  name: string;
  /** HeyReach's own status string, kept verbatim so the UI can show what the API said. */
  status: string;
  state: CampaignState;
  startedAt: string;
  /**
   * How far through its list the campaign is. This is what makes a live campaign with no replies
   * reportable: "running, 298 of 711 still to contact" is a fact, "no replies" alone is an absence.
   */
  progress: { total: number; pending: number; inProgress: number; finished: number };
};

export type CampaignStatus = {
  /** False means we could not ask. Nothing below should then be read as "there are none". */
  available: boolean;
  /** Why we could not ask, for the UI to show instead of an empty list. */
  reason: string;
  fetchedAt: string;
  running: CampaignStatusRow[];
  /** Set to launch but not started yet — the answer to "what goes live next week?". */
  scheduled: CampaignStatusRow[];
  paused: CampaignStatusRow[];
  /** Finished, cancelled or stopped — the answer to "why did replies drop this week?". */
  finished: CampaignStatusRow[];
  /** Total campaigns in the workspace, drafts included, so a count can be sanity-checked. */
  total: number;
  /**
   * Status strings we did not recognise. HeyReach can add one, and a new status must surface as a
   * question rather than quietly demoting a live campaign out of `running`.
   */
  unrecognised: string[];
};

/**
 * HeyReach's documented statuses are DRAFT, IN_PROGRESS, PAUSED, FINISHED, CANCELED, FAILED,
 * STARTING and SCHEDULED. The extra synonyms are defensive: the mapping is the one thing here that
 * silently changes meaning if HeyReach renames a status, so it errs towards recognising more.
 */
const STATES: Record<CampaignState, string[]> = {
  running: ["IN_PROGRESS", "STARTING", "ACTIVE", "RUNNING", "STARTED"],
  scheduled: ["SCHEDULED", "QUEUED"],
  paused: ["PAUSED", "PAUSING", "ON_HOLD"],
  finished: ["FINISHED", "COMPLETED", "CANCELED", "CANCELLED", "STOPPED", "ARCHIVED", "FAILED"],
  draft: ["DRAFT", "NEW", "CREATED"],
  unknown: [],
};

/** Normalises HeyReach's status string into the four states a report cares about. */
export function classifyState(status: unknown): CampaignState {
  const normalised = text(status).toUpperCase().replace(/[^A-Z]/g, "");
  if (!normalised) return "unknown";
  for (const [state, values] of Object.entries(STATES) as Array<[CampaignState, string[]]>) {
    if (values.some((value) => value.replace(/[^A-Z]/g, "") === normalised)) return state;
  }
  return "unknown";
}

export const emptyStatus = (reason: string): CampaignStatus => ({
  available: false,
  reason,
  fetchedAt: new Date().toISOString(),
  running: [],
  scheduled: [],
  paused: [],
  finished: [],
  total: 0,
  unrecognised: [],
});

/**
 * Sorts a raw `/campaign/GetAll` page set into states.
 *
 * Split out from the fetch so the classification is testable without an API key, which is the only
 * way it gets tested at all — there is no HeyReach account in CI.
 */
export function summariseCampaigns(rows: unknown[]): CampaignStatus {
  const buckets: Record<CampaignState, CampaignStatusRow[]> = {
    running: [],
    scheduled: [],
    paused: [],
    finished: [],
    draft: [],
    unknown: [],
  };
  const unrecognised = new Set<string>();
  const count = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = object(raw);
    const id = text(row.id ?? row.campaignId);
    const name = text(row.name ?? row.campaignName);
    if (!id && !name) continue;
    const status = text(row.status);
    const state = classifyState(status);
    if (state === "unknown" && status) unrecognised.add(status);
    const stats = object(row.progressStats);
    buckets[state].push({
      id,
      name: name || `Campaign ${id}`,
      status,
      state,
      startedAt: iso(row.startedAt ?? row.creationTime ?? row.createdAt),
      progress: {
        total: count(stats.totalUsers),
        pending: count(stats.totalUsersPending),
        inProgress: count(stats.totalUsersInProgress),
        finished: count(stats.totalUsersFinished),
      },
    });
  }

  const byStart = (a: CampaignStatusRow, b: CampaignStatusRow) => b.startedAt.localeCompare(a.startedAt);
  return {
    available: true,
    reason: "",
    fetchedAt: new Date().toISOString(),
    // A campaign whose status we cannot read might be live, so it is listed with the running ones
    // rather than dropped. `unrecognised` says which, so the mistake is visible either way.
    running: [...buckets.running, ...buckets.unknown].sort(byStart),
    scheduled: [...buckets.scheduled].sort(byStart),
    paused: [...buckets.paused].sort(byStart),
    finished: [...buckets.finished].sort(byStart),
    total: Object.values(buckets).reduce((count, bucket) => count + bucket.length, 0),
    unrecognised: [...unrecognised],
  };
}

/** Campaign name (lowercased) → its state, for annotating the reply-derived campaign table. */
export function stateByName(status: CampaignStatus): Map<string, CampaignStatusRow> {
  const map = new Map<string, CampaignStatusRow>();
  for (const row of [...status.running, ...status.scheduled, ...status.paused, ...status.finished]) {
    const key = row.name.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, row);
  }
  return map;
}

const cache = new Map<string, { expires: number; status: CampaignStatus }>();

async function fetchAllCampaigns(apiKey: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; offset < PAGE_CEILING; offset += PAGE_SIZE) {
    const response = await fetch(`${API_BASE.replace(/\/$/, "")}/campaign/GetAll`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ offset, limit: PAGE_SIZE }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HeyReach campaign list returned ${response.status}`);
    const payload = object(await response.json().catch(() => ({})));
    const items = Array.isArray(payload.items) ? payload.items : [];
    rows.push(...items);
    const total = Number(payload.totalCount ?? rows.length);
    if (items.length < PAGE_SIZE || rows.length >= total) break;
  }
  return rows;
}

/**
 * The one call the report makes. Never throws: a client whose HeyReach is down still gets a report,
 * with the campaign block marked unavailable.
 */
export async function campaignStatusFor(apiKey: string): Promise<CampaignStatus> {
  const key = text(apiKey);
  if (!key) return emptyStatus("No HeyReach API key is saved for this client.");

  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.status;

  try {
    const status = summariseCampaigns(await fetchAllCampaigns(key));
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, status });
    return status;
  } catch (error) {
    return emptyStatus(error instanceof Error ? error.message : "HeyReach could not be reached.");
  }
}
