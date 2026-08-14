// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Which of a client's HeyReach campaigns are actually active.
 *
 * Everything else in a report is derived from replies we have already stored, which means a campaign
 * only appears once somebody answers it. That is the wrong shape for the question a client asks on a
 * Friday — "what is live?" — because a campaign that is switched on and quiet looks identical to one
 * that was switched off a fortnight ago. The only place that distinction exists is HeyReach, so it is
 * fetched at report time.
 *
 * ── What "active" means here ────────────────────────────────────────────────────────────────────
 * Not what HeyReach means by it. HeyReach keeps a campaign in IN_PROGRESS while leads already in the
 * sequence work through their remaining steps, so a campaign can report itself as running for weeks
 * after the last new lead was contacted. In QC's terms that campaign is finished: there are no
 * pending leads left to enter the sequence, so nothing new will come out of it.
 *
 * So: active means IN_PROGRESS *and* pending leads remaining. IN_PROGRESS with no pending leads is
 * `worked-through` — still ticking over, but done in every sense the client cares about. Getting this
 * backwards is the difference between telling a client four campaigns are working for them and
 * telling them two are.
 *
 * The key is per client (`rr_workspaces.heyreach_api_key_ciphertext`) and a HeyReach key is scoped to
 * the workspace it was issued for, so no separate workspace id is needed — the key *is* the scope.
 *
 * Failure is a first-class outcome. A missing key or an unreachable HeyReach must leave the report
 * saying "status unknown" rather than "nothing is running", because those two read the same to a
 * client and only one of them is true.
 *
 * ── Whose campaigns ─────────────────────────────────────────────────────────────────────────────
 * Only ours. Several clients tried outbound themselves before the engagement and those campaigns sit
 * in the same account behind the same key; `shared/campaign-code.mjs` holds the rule that tells them
 * apart, and this file drops everything that fails it.
 */

import { isOurCampaign } from "../../shared/campaign-code.mjs";

type Row = Record<string, unknown>;

const API_BASE = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";
const PAGE_SIZE = 100; // HeyReach caps a page at 100 records.
/**
 * A client runs fewer than ten campaigns at once and has tens in total, so one page is the norm and
 * two is the exception. The ceiling exists to stop a wrong `totalCount` looping, not to support scale
 * that does not exist.
 */
const PAGE_CEILING = 300;
/**
 * Statuses worth asking for. Everything HeyReach has already finished or never started is noise in a
 * report about this week, and leaving it out roughly halves the payload.
 */
const REQUESTED_STATUSES = ["IN_PROGRESS", "STARTING", "SCHEDULED", "PAUSED"];
/**
 * A page of 66 campaigns normally comes back in about a second, but the first call after a quiet
 * period has been seen to take 26 — HeyReach appears to cold-start. The timeout is set above that
 * outlier deliberately: a report that waits is annoying, one that tells a client nothing is running
 * because of a cold start is wrong.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Long enough that clicking Generate twice does not hit HeyReach twice, short enough that a campaign
 * switched on mid-session shows up. Report numbers are deliberately uncached; this is a courtesy to
 * someone else's rate limit, not a cache of the report.
 */
const CACHE_TTL_MS = 60_000;
/**
 * Connection requests one LinkedIn account sends in a day.
 *
 * QC's own sending cap, not LinkedIn's limit — it is the number the pulse check and the campaign
 * schedules are both built around, so a runway calculated from anything else would contradict what the
 * team already tells clients.
 */
export const DAILY_CONNECTIONS_PER_SENDER = 25;

/**
 * Fields HeyReach has been seen to carry the assigned LinkedIn accounts under.
 *
 * `campaignAccountIds` is the one a live `/campaign/GetAll` actually returns; the rest are read as well
 * because the endpoint is not documented field by field and a rename would silently zero every runway.
 * The failure mode is the honest one: no recognised field means no senders, which means the runway is
 * unknown rather than wrong.
 */
const SENDER_FIELDS = [
  "campaignAccountIds",
  "accountIds",
  "linkedInAccountIds",
  "linkedInUserIds",
  "campaignAccounts",
  "linkedInSenders",
  "linkedInUsers",
  "senders",
];

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const iso = (value: unknown) => {
  const parsed = new Date(text(value));
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
};

/** What HeyReach's status says, before the pending-lead rule is applied. */
export type ReportedState = "running" | "scheduled" | "paused" | "closed" | "draft" | "unknown";

/** What the campaign is to us. `worked-through` is the one HeyReach has no word for. */
export type CampaignState = "active" | "worked-through" | "scheduled" | "paused" | "closed" | "draft" | "unknown";

export type CampaignProgress = {
  /** Leads on the campaign's list, including any HeyReach excluded. */
  listSize: number;
  /** Leads yet to enter the sequence. Above zero is what makes a campaign active. */
  pending: number;
  /**
   * Leads that have entered the sequence: those still moving through it and those that have come out
   * the far end, as one number. Split apart it invites the misreading that a campaign with leads
   * "in progress" is still doing new work, which is exactly the confusion this file exists to end.
   */
  contacted: number;
};

export type CampaignStatusRow = {
  id: string;
  name: string;
  /** HeyReach's own status string, kept verbatim so a report can show what the API actually said. */
  status: string;
  state: CampaignState;
  /** When the campaign went live. Empty if HeyReach has no start date, e.g. a scheduled campaign. */
  launchedAt: string;
  progress: CampaignProgress;
  /** LinkedIn accounts assigned to send it. Zero means HeyReach did not say, not that nobody is on it. */
  senders: number;
  /**
   * The people behind that number, where HeyReach gave us names for them.
   *
   * A client knows Eyal and Roi; "3 senders" tells them nothing they can act on. Kept separate from the
   * count rather than replacing it because the two can disagree — an account assigned to a campaign but
   * since removed from the workspace still counts towards sending capacity and has no name to print.
   * The runway is computed from the count for exactly that reason.
   */
  senderNames: string[];
  /** Days of sending left at the current sender count. Null when the sender count is unknown. */
  daysLeftInSending: number | null;
};

/**
 * How much longer a campaign has to run before its list is exhausted.
 *
 * Pending leads divided by the daily send capacity, which is the sender count times the per-sender cap:
 * 500 pending across 4 senders is 100 a day, so five days left. It is the answer to the question a
 * client actually asks about a campaign — not "how big is the list" but "when do you need more leads?"
 *
 * Null rather than zero when there are no senders. A campaign with nobody assigned is not finishing
 * today; it is not sending at all, and the honest answer is that we cannot say.
 */
export function sendingDaysLeft(pending: number, senders: number): number | null {
  if (!Number.isFinite(pending) || !Number.isFinite(senders) || senders <= 0) return null;
  if (pending <= 0) return 0;
  return Math.ceil(pending / (senders * DAILY_CONNECTIONS_PER_SENDER));
}

/**
 * The distinct accounts assigned to a campaign, whichever shape HeyReach used to list them.
 *
 * Ids rather than a count, because the count is only half of what a report wants — see `senderNames`.
 * A field carrying objects rather than ids is read for a name too, so a payload that already names its
 * senders does not need the second call.
 */
function senderRefs(row: Row): Array<{ id: string; name: string }> {
  for (const field of SENDER_FIELDS) {
    const value = row[field];
    if (!Array.isArray(value)) continue;
    const byId = new Map<string, string>();
    for (const item of value) {
      if (item && typeof item === "object") {
        const account = object(item);
        const id = text(account.id ?? account.linkedInUserId ?? account.accountId ?? account.linkedInAccountId);
        if (id && !byId.has(id)) byId.set(id, accountName(account));
        continue;
      }
      const id = text(item);
      if (id && !byId.has(id)) byId.set(id, "");
    }
    if (byId.size) return [...byId].map(([id, name]) => ({ id, name }));
  }
  return [];
}

/**
 * A LinkedIn account's display name, from whichever of the several name fields HeyReach populated.
 *
 * Never the email address. `/li_account/GetAll` always carries one and it is usually a personal Gmail —
 * printing "eyalbe@gmail.com" as a sender in a client report would be worse than printing nothing.
 */
function accountName(account: Row): string {
  const full = text(account.fullName ?? account.name);
  if (full) return full;
  return [text(account.firstName), text(account.lastName)].filter(Boolean).join(" ");
}

export type CampaignStatus = {
  /** False means we could not ask. Nothing below should then be read as "there are none". */
  available: boolean;
  /** Why we could not ask, for the report to show instead of an empty list. */
  reason: string;
  fetchedAt: string;
  /** Live and still feeding new leads into the sequence — the only list a client should read as "running". */
  active: CampaignStatusRow[];
  /** HeyReach says in progress, but the list is exhausted. Complete, in QC's terms. */
  workedThrough: CampaignStatusRow[];
  /** Set to launch but not started — the answer to "what goes live next week?". */
  scheduled: CampaignStatusRow[];
  paused: CampaignStatusRow[];
  /** Total campaigns HeyReach returned, so a count can be sanity-checked against the app. */
  total: number;
  /**
   * Status strings we did not recognise. HeyReach can add one, and a new status must surface as a
   * question rather than quietly demoting a live campaign out of `active`.
   */
  unrecognised: string[];
};

/**
 * HeyReach's documented statuses are DRAFT, IN_PROGRESS, PAUSED, FINISHED, CANCELED, FAILED,
 * STARTING and SCHEDULED. The extra synonyms are defensive: this mapping is the one thing here that
 * silently changes meaning if HeyReach renames a status, so it errs towards recognising more.
 */
const REPORTED_STATES: Record<ReportedState, string[]> = {
  running: ["IN_PROGRESS", "STARTING", "ACTIVE", "RUNNING", "STARTED"],
  scheduled: ["SCHEDULED", "QUEUED"],
  paused: ["PAUSED", "PAUSING", "ON_HOLD"],
  closed: ["FINISHED", "COMPLETED", "CANCELED", "CANCELLED", "STOPPED", "ARCHIVED", "FAILED"],
  draft: ["DRAFT", "NEW", "CREATED"],
  unknown: [],
};

/** Normalises HeyReach's status string, tolerating casing and punctuation drift. */
export function classifyReportedState(status: unknown): ReportedState {
  const normalised = text(status).toUpperCase().replace(/[^A-Z]/g, "");
  if (!normalised) return "unknown";
  for (const [state, values] of Object.entries(REPORTED_STATES) as Array<[ReportedState, string[]]>) {
    if (values.some((value) => value.replace(/[^A-Z]/g, "") === normalised)) return state;
  }
  return "unknown";
}

/**
 * Applies the pending-lead rule. This is the definition the rest of the app depends on, so it is a
 * named function rather than an inline condition.
 */
export function resolveState(reported: ReportedState, pending: number): CampaignState {
  if (reported === "running") return pending > 0 ? "active" : "worked-through";
  // An unreadable status might be a live campaign, and with leads still to contact it is treated as
  // one — better to over-report a campaign that shows up in the list than to hide a working one.
  if (reported === "unknown") return pending > 0 ? "active" : "unknown";
  return reported;
}

export const emptyStatus = (reason: string): CampaignStatus => ({
  available: false,
  reason,
  fetchedAt: new Date().toISOString(),
  active: [],
  workedThrough: [],
  scheduled: [],
  paused: [],
  total: 0,
  unrecognised: [],
});

/**
 * Sorts a raw `/campaign/GetAll` payload into states.
 *
 * Split out from the fetch so the classification is testable without an API key, which is the only
 * way it gets tested at all — there is no HeyReach account in CI.
 *
 * `senderNamesById` comes from a second endpoint because the campaign payload lists its senders as bare
 * numeric ids. Passed in rather than fetched here so this stays pure; absent, campaigns still carry the
 * sender count and the runway, and only the names are missing.
 */
export function summariseCampaigns(
  rows: unknown[],
  senderNamesById: Map<string, string> = new Map(),
): CampaignStatus {
  const buckets: Record<CampaignState, CampaignStatusRow[]> = {
    active: [],
    "worked-through": [],
    scheduled: [],
    paused: [],
    closed: [],
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
    // Clients who ran their own outbound before hiring us still have those campaigns in the same
    // account. Reporting on them would credit or blame us for work we never touched, so the naming
    // convention decides. See `shared/campaign-code.mjs` for why the pattern is looser than "XX001".
    if (!isOurCampaign(name)) continue;

    const status = text(row.status);
    const reported = classifyReportedState(status);
    if (reported === "unknown" && status) unrecognised.add(status);

    const stats = object(row.progressStats);
    const progress: CampaignProgress = {
      listSize: count(stats.totalUsers),
      pending: count(stats.totalUsersPending),
      contacted: count(stats.totalUsersInProgress) + count(stats.totalUsersFinished),
    };
    const state = resolveState(reported, progress.pending);
    const refs = senderRefs(row);

    buckets[state].push({
      id,
      name: name || `Campaign ${id}`,
      status,
      state,
      launchedAt: iso(row.startedAt ?? row.creationTime ?? row.createdAt),
      progress,
      senders: refs.length,
      senderNames: refs.map((ref) => ref.name || senderNamesById.get(ref.id) || "").filter(Boolean),
      daysLeftInSending: sendingDaysLeft(progress.pending, refs.length),
    });
  }

  // Newest first: the campaign that launched this week is the one being asked about.
  const byLaunch = (a: CampaignStatusRow, b: CampaignStatusRow) => b.launchedAt.localeCompare(a.launchedAt);
  return {
    available: true,
    reason: "",
    fetchedAt: new Date().toISOString(),
    active: [...buckets.active].sort(byLaunch),
    workedThrough: [...buckets["worked-through"], ...buckets.unknown].sort(byLaunch),
    scheduled: [...buckets.scheduled].sort(byLaunch),
    paused: [...buckets.paused].sort(byLaunch),
    total: Object.values(buckets).reduce((sum, bucket) => sum + bucket.length, 0),
    unrecognised: [...unrecognised],
  };
}

/** Every campaign the status covers, in the order a report would list them. */
export const allCampaigns = (status: CampaignStatus): CampaignStatusRow[] => [
  ...status.active,
  ...status.scheduled,
  ...status.workedThrough,
  ...status.paused,
];

/** Campaign name (lowercased) → its row, for annotating the reply-derived campaign table. */
export function stateByName(status: CampaignStatus): Map<string, CampaignStatusRow> {
  const map = new Map<string, CampaignStatusRow>();
  for (const row of allCampaigns(status)) {
    const key = row.name.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, row);
  }
  return map;
}

/**
 * Narrows a status to a chosen set of campaign ids, for the toggles on the report builder.
 *
 * No selection at all means everything — a caller that has never heard of the toggles gets the whole
 * picture. An *empty* selection is a real choice and is honoured, because someone who unticks every
 * campaign has said what they want.
 */
export function selectCampaigns(status: CampaignStatus, ids: string[] | undefined | null): CampaignStatus {
  if (!ids) return status;
  const keep = new Set(ids.map((id) => text(id)).filter(Boolean));
  const filter = (rows: CampaignStatusRow[]) => rows.filter((row) => keep.has(row.id));
  return {
    ...status,
    active: filter(status.active),
    workedThrough: filter(status.workedThrough),
    scheduled: filter(status.scheduled),
    paused: filter(status.paused),
  };
}

const cache = new Map<string, { expires: number; status: CampaignStatus }>();

async function fetchCampaignPages(apiKey: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let offset = 0; offset < PAGE_CEILING; offset += PAGE_SIZE) {
    const response = await fetch(`${API_BASE.replace(/\/$/, "")}/campaign/GetAll`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ offset, limit: PAGE_SIZE, statuses: REQUESTED_STATUSES }),
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
 * Every LinkedIn account in the workspace, as id → display name.
 *
 * The campaign payload names its senders only as numeric ids, so this is the lookup that turns
 * `campaignAccountIds: [117558, 187697]` into "Eyal Ben Ezra and Roi Galipapa". The path is
 * `/li_account/GetAll` — `/linkedinaccount/GetAll`, which the shape of every other route suggests,
 * returns 404.
 *
 * Failure is swallowed to an empty map on purpose. Names are an improvement on the sender count, not a
 * precondition for it, and a report must not lose its campaign section because one extra call failed.
 */
async function fetchSenderNames(apiKey: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (let offset = 0; offset < PAGE_CEILING; offset += PAGE_SIZE) {
      const response = await fetch(`${API_BASE.replace(/\/$/, "")}/li_account/GetAll`, {
        method: "POST",
        headers: { "X-API-KEY": apiKey, "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ offset, limit: PAGE_SIZE }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!response.ok) break;
      const payload = object(await response.json().catch(() => ({})));
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const raw of items) {
        const account = object(raw);
        const id = text(account.id);
        const name = accountName(account);
        if (id && name) names.set(id, name);
      }
      const total = Number(payload.totalCount ?? names.size);
      if (items.length < PAGE_SIZE || names.size >= total) break;
    }
  } catch {
    /* names are a nicety; the count and the runway do not depend on them */
  }
  return names;
}

/**
 * What a report asks HeyReach for. Never throws: a client whose HeyReach is down still gets a report,
 * with the campaign block marked unavailable.
 *
 * The two calls run together because neither needs the other's answer, and the accounts list is small
 * and identical for every campaign in the workspace — one lookup serves the whole report.
 */
export async function campaignStatusFor(apiKey: string): Promise<CampaignStatus> {
  const key = text(apiKey);
  if (!key) return emptyStatus("No HeyReach API key is saved for this client.");

  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.status;

  try {
    const [rows, senderNames] = await Promise.all([fetchCampaignPages(key), fetchSenderNames(key)]);
    const status = summariseCampaigns(rows, senderNames);
    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, status });
    return status;
  } catch (error) {
    return emptyStatus(error instanceof Error ? error.message : "HeyReach could not be reached.");
  }
}
