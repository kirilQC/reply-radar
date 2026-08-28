// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Every HeyReach read endpoint, in one place, with the traps written down.
 *
 * HeyReach publishes no reachable OpenAPI document — `/swagger/v1/swagger.json` is a 404,
 * `/api/public/swagger.json` answers 401 "Missing API key" and then still 404s once a valid key is
 * supplied. So this file is the specification: every method below was probed against a live account
 * and the status recorded, which is also why the endpoints that *don't* exist are documented rather
 * than quietly omitted. Someone will otherwise spend an afternoon rediscovering that `GetChatroom`
 * is gone.
 *
 * ── Read-only, by construction ──────────────────────────────────────────────────────────────────
 * HeyReach can send messages, add leads, pause campaigns and delete lists. None of that is here.
 * The assistant this file feeds is driven by free text from a chat box, and the gap between
 * "summarise Cotool's replies" and "message Cotool's replies" is one word. The write endpoints are
 * left unimplemented so that no prompt, however phrased, can reach them — an allowlist a model
 * cannot argue with is worth more than an instruction telling it not to.
 *
 * ── The trap that returns a plausible wrong answer ──────────────────────────────────────────────
 * `inbox/GetConversationsV2` takes its filters **nested under a `filters` key**. Passed flat they are
 * not rejected, not warned about — they are silently dropped and you get the unfiltered set. On the
 * account this was probed against, `{"filters":{"linkedInAccountIds":[155351]}}` returns 552
 * conversations and `{"linkedInAccountIds":[155351]}` returns 1901. Both are HTTP 200. That is the
 * worst possible failure shape: a number that looks like an answer. `conversations()` below owns the
 * nesting so no caller can get it wrong.
 *
 * ── Other things learned the hard way ───────────────────────────────────────────────────────────
 * - `campaign/GetLeadsFromCampaign` returns **pending** leads — those yet to enter the sequence. It
 *   is not the campaign's audience and cannot be used to count who was contacted.
 * - `stats/GetOverallStats` wants `startDate` and `endDate` together or neither. One alone fails.
 *   Its `byDayStats` is keyed by ISO date and is mostly zero-filled, so it is large out of all
 *   proportion to its value — never hand it to a language model whole.
 * - `inbox/GetChatroom` 404s. It does not matter: `GetConversationsV2` embeds `messages` inline, so
 *   the thread arrives with the conversation.
 * - `webhook/GetAll` and `webhook/GetAllWebhooks` both 404. There is no way to read webhooks back.
 * - Rate fields (`messageReplyRate`, `connectionAcceptanceRate`, …) are 0–1 fractions, not percents.
 * - A key is scoped to one HeyReach workspace, so the key *is* the client selector. There is no
 *   workspace parameter anywhere in this API.
 *
 * ── Deliberately more than is currently called ──────────────────────────────────────────────────
 * `assistant-tools.ts` reaches about two thirds of what is below; `campaignById`,
 * `campaignPendingLeads`, `senderById`, `network`, `listById`, `leadsInList`, `companiesInList` and
 * `checkApiKey` have no caller yet. They are here because the point of this file is to be the map —
 * each one was probed, its shape confirmed, and its quirks written down, and that knowledge is worth
 * more on the shelf than rediscovered in six months. Wiring a new tool to one of them should be a
 * five-line change, not another afternoon with curl.
 */

const API_BASE = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";
/** HeyReach caps a page at 100 records on every paged endpoint that was tested. */
const PAGE_SIZE = 100;
/**
 * Matches `heyreach-campaigns.ts`, and for the same reason: the first call after a quiet period has
 * been measured at 26 seconds where a warm one takes about one. HeyReach appears to cold-start, and a
 * timeout below that outlier turns a slow answer into a wrong one.
 */
const TIMEOUT_MS = 30_000;

type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** A paged HeyReach response. `total` is HeyReach's own count, not the length of `items`. */
export type Page<T> = { items: T[]; total: number };

/**
 * One HeyReach call.
 *
 * Every endpoint here is a read, but HeyReach uses POST for most of them — the method is about how
 * the filters travel, not about mutation, and `GET` is only accepted where the whole request is a
 * query string.
 *
 * Errors carry HeyReach's own body. A bare "400" is unactionable; the body usually names the field.
 */
async function call(apiKey: string, path: string, body?: unknown): Promise<unknown> {
  const key = text(apiKey);
  if (!key) throw new Error("No HeyReach API key is saved for this client.");
  const response = await fetch(`${API_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-API-KEY": key,
      Accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`HeyReach ${path} returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return response.json().catch(() => ({}));
}

/**
 * Walks a paged endpoint until HeyReach runs out or `max` records have been collected.
 *
 * The ceiling is a parameter rather than a constant because the callers want wildly different
 * amounts: a campaign list is tens of rows and wants all of them, while "recent replies" wants the
 * first hundred of nineteen hundred. Paging a language model through 1,901 conversations would blow
 * the context window and answer no question better.
 */
async function paged(apiKey: string, path: string, body: Row, max: number): Promise<Page<Row>> {
  const items: Row[] = [];
  let total = 0;
  for (let offset = 0; items.length < max; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, max - items.length);
    const payload = object(await call(apiKey, path, { ...body, offset, limit }));
    const batch = list(payload.items).map(object);
    total = num(payload.totalCount) || total || batch.length;
    items.push(...batch);
    if (batch.length < limit || items.length >= total) break;
  }
  return { items, total };
}

/* ── Authentication ──────────────────────────────────────────────────────────────────────────── */

/** Whether a key is live. The cheapest possible call, and the only one that needs no arguments. */
export async function checkApiKey(apiKey: string): Promise<boolean> {
  try {
    await call(apiKey, "auth/CheckApiKey");
    return true;
  } catch {
    return false;
  }
}

/* ── Campaigns ───────────────────────────────────────────────────────────────────────────────── */

/**
 * HeyReach's campaign shape, reduced to what a report or an answer actually uses.
 *
 * `progressStats` is flattened because its four counts are the whole point of the object and the
 * nesting only ever gets in the way. `pending` above zero is what distinguishes a campaign that is
 * still feeding new leads from one that is merely finishing the ones it has — see
 * `heyreach-campaigns.ts`, which owns that rule.
 */
export type HeyReachCampaign = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  startedAt: string;
  listId: string;
  listName: string;
  senderIds: string[];
  listSize: number;
  pending: number;
  inProgress: number;
  finished: number;
  failed: number;
};

const campaign = (row: Row): HeyReachCampaign => {
  const stats = object(row.progressStats);
  return {
    id: text(row.id),
    name: text(row.name),
    status: text(row.status),
    createdAt: text(row.creationTime),
    startedAt: text(row.startedAt),
    listId: text(row.linkedInUserListId),
    listName: text(row.linkedInUserListName),
    senderIds: list(row.campaignAccountIds).map(text).filter(Boolean),
    listSize: num(stats.totalUsers),
    pending: num(stats.totalUsersPending),
    inProgress: num(stats.totalUsersInProgress),
    finished: num(stats.totalUsersFinished),
    failed: num(stats.totalUsersFailed),
  };
};

/** Every campaign in the workspace, newest last as HeyReach returns them. */
export async function campaigns(apiKey: string, max = 300): Promise<Page<HeyReachCampaign>> {
  const page = await paged(apiKey, "campaign/GetAll", {}, max);
  return { items: page.items.map(campaign), total: page.total };
}

/** One campaign by id. Same shape as a row from `campaigns()`. */
export async function campaignById(apiKey: string, campaignId: string): Promise<HeyReachCampaign> {
  return campaign(object(await call(apiKey, `campaign/GetById?campaignId=${encodeURIComponent(campaignId)}`)));
}

/**
 * The message sequence: what the campaign actually says, and how long it waits between steps.
 *
 * Returned close to verbatim. The step objects carry HeyReach's own action names
 * (`CONNECT`, `MESSAGE`, `VIEW`, `LIKE_POST`, `END`) and their bodies are the client's copy, which
 * is the part a person asking "what does CT003 send?" wants to read unaltered.
 */
export async function campaignSequence(apiKey: string, campaignId: string): Promise<Row> {
  return object(await call(apiKey, `campaign/GetCampaignSequence?campaignId=${encodeURIComponent(campaignId)}`));
}

/**
 * Leads a campaign has **not yet contacted**.
 *
 * Named for what it returns rather than what HeyReach calls it. `GetLeadsFromCampaign` reads as "the
 * campaign's leads" and is not: contacted leads are absent, so using it to answer "who did we reach?"
 * returns the exact opposite set.
 */
export async function campaignPendingLeads(apiKey: string, campaignId: string, max = 100): Promise<Page<Row>> {
  return paged(apiKey, "campaign/GetLeadsFromCampaign", { campaignId, timeFilter: "Everywhere" }, max);
}

/**
 * Which campaigns a person is in — the "is this lead already being worked?" question.
 *
 * Any one identifier will do. A profile URL is what someone pastes out of LinkedIn, so it is first.
 */
export async function campaignsForLead(
  apiKey: string,
  lead: { profileUrl?: string; linkedinId?: string; email?: string },
  max = 100,
): Promise<Page<HeyReachCampaign>> {
  const page = await paged(apiKey, "campaign/GetCampaignsForLead", { ...lead }, max);
  return { items: page.items.map(campaign), total: page.total };
}

/* ── Sending accounts ────────────────────────────────────────────────────────────────────────── */

/**
 * A LinkedIn account that sends for the client.
 *
 * `authValid` and `active` are separate on purpose: an account can be switched on and still have a
 * dead session, which is the state that silently stops a campaign. Reporting only `active` is how
 * that goes unnoticed.
 */
export type HeyReachSender = {
  id: string;
  name: string;
  profileUrl: string;
  active: boolean;
  authValid: boolean;
  activeCampaigns: number;
};

const sender = (row: Row): HeyReachSender => ({
  id: text(row.id),
  name: [text(row.firstName), text(row.lastName)].filter(Boolean).join(" "),
  profileUrl: text(row.profileUrl),
  active: row.isActive === true,
  authValid: row.authIsValid === true,
  activeCampaigns: num(row.activeCampaigns),
});

/**
 * Every sending account in the workspace.
 *
 * The email address HeyReach carries is deliberately dropped. It is usually a personal Gmail, and
 * this data reaches a chat box that people screenshot.
 */
export async function senders(apiKey: string, max = 100): Promise<Page<HeyReachSender>> {
  const page = await paged(apiKey, "li_account/GetAll", {}, max);
  return { items: page.items.map(sender), total: page.total };
}

/** One sending account by id, including its daily limits and cooldowns. */
export async function senderById(apiKey: string, accountId: string): Promise<Row> {
  return object(await call(apiKey, `li_account/GetById?accountId=${encodeURIComponent(accountId)}`));
}

/** The sender's own LinkedIn connections. Note `pageNumber`/`pageSize` — this endpoint pages unlike the rest. */
export async function network(apiKey: string, senderId: string, pageNumber = 1, pageSize = 100): Promise<Row> {
  return object(await call(apiKey, "MyNetwork/GetMyNetworkForSender", { senderId, pageNumber, pageSize }));
}

/* ── Lead lists ──────────────────────────────────────────────────────────────────────────────── */

export type HeyReachList = {
  id: string;
  name: string;
  /** `USER_LIST` or `COMPANY_LIST`. Which one decides whether `companiesInList` works at all. */
  type: string;
  size: number;
  createdAt: string;
  campaignIds: string[];
};

const leadList = (row: Row): HeyReachList => ({
  id: text(row.id),
  name: text(row.name),
  type: text(row.listType),
  size: num(row.totalItemsCount),
  createdAt: text(row.creationTime),
  campaignIds: list(row.campaignIds).map(text).filter(Boolean),
});

/** Every lead list in the workspace. */
export async function lists(apiKey: string, max = 200): Promise<Page<HeyReachList>> {
  const page = await paged(apiKey, "list/GetAll", {}, max);
  return { items: page.items.map(leadList), total: page.total };
}

/** One list by id. */
export async function listById(apiKey: string, listId: string): Promise<HeyReachList> {
  return leadList(object(await call(apiKey, `list/GetById?listId=${encodeURIComponent(listId)}`)));
}

/** The people on a list. */
export async function leadsInList(apiKey: string, listId: string, max = 100): Promise<Page<Row>> {
  return paged(apiKey, "list/GetLeadsFromList", { listId }, max);
}

/**
 * One page of a list's people, at an explicit offset. For a resumable crawl of a whole campaign list, where
 * the caller keeps the offset across requests (a background job that cannot hold the whole list in one call).
 */
export async function leadsInListPage(apiKey: string, listId: string, offset: number, limit = 100): Promise<Page<Row>> {
  const payload = object(await call(apiKey, "list/GetLeadsFromList", { listId, offset, limit }));
  return { items: list(payload.items).map(object), total: num(payload.totalCount) };
}

/**
 * The companies on a list.
 *
 * Only valid for a `COMPANY_LIST`. Given a `USER_LIST` id HeyReach answers 400, which is correct
 * behaviour and reads like a broken endpoint — check `type` from `lists()` first.
 */
export async function companiesInList(apiKey: string, listId: string, max = 100): Promise<Page<Row>> {
  return paged(apiKey, "list/GetCompaniesFromList", { listId }, max);
}

/** Which lists a person appears on. */
export async function listsForLead(
  apiKey: string,
  lead: { profileUrl?: string; linkedinId?: string; email?: string },
  max = 100,
): Promise<Page<HeyReachList>> {
  const page = await paged(apiKey, "list/GetListsForLead", { ...lead }, max);
  return { items: page.items.map(leadList), total: page.total };
}

/* ── People ──────────────────────────────────────────────────────────────────────────────────── */

/** Everything HeyReach knows about one person, by profile URL. */
export async function lead(apiKey: string, profileUrl: string): Promise<Row> {
  return object(await call(apiKey, "lead/GetLead", { profileUrl }));
}

/** The tags on one person — where HeyReach's own "interested" auto-tagging lands. */
export async function leadTags(apiKey: string, profileUrl: string): Promise<Row> {
  return object(await call(apiKey, "lead/GetTags", { profileUrl }));
}

/* ── Statistics ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The metric vocabulary both stats endpoints share.
 *
 * Every rate is a 0–1 fraction. `messageReplyRate: 0.043` is 4.3%, and the one thing nobody must do
 * is print it as "0.04%" or "4.3" without deciding which.
 *
 * `totalMessageStarted` is conversations opened, `messagesSent` is messages — a campaign with a
 * three-step sequence has far more of the latter, and dividing replies by the wrong one understates
 * performance by roughly the length of the sequence.
 *
 * **`leadsContacted` is only populated on the workspace total.** Every one of the 39 campaign rows on
 * the account this was probed against returned zero for it, including a campaign that had sent 881
 * connection requests. It is a real field returning a real number in one context and a meaningless
 * zero in the other, which is why `statsByCampaign` callers must not report it — a zero there reads as
 * "we contacted nobody" and is simply HeyReach not answering the question.
 */
export type HeyReachMetrics = {
  profileViews: number;
  postLikes: number;
  follows: number;
  messagesSent: number;
  conversationsStarted: number;
  messageReplies: number;
  inmailsSent: number;
  inmailsStarted: number;
  inmailReplies: number;
  connectionsSent: number;
  connectionsAccepted: number;
  leadsContacted: number;
  taggedInterested: number;
  totalTagged: number;
  /** Fractions, 0–1. */
  messageReplyRate: number;
  inmailReplyRate: number;
  connectionAcceptanceRate: number;
  interestedRate: number;
};

const metrics = (row: Row): HeyReachMetrics => ({
  profileViews: num(row.profileViews),
  postLikes: num(row.postLikes),
  follows: num(row.follows),
  messagesSent: num(row.messagesSent),
  conversationsStarted: num(row.totalMessageStarted),
  messageReplies: num(row.totalMessageReplies),
  inmailsSent: num(row.inmailMessagesSent),
  inmailsStarted: num(row.totalInmailStarted),
  inmailReplies: num(row.totalInmailReplies),
  connectionsSent: num(row.connectionsSent),
  connectionsAccepted: num(row.connectionsAccepted),
  leadsContacted: num(row.uniqueLeadsContacted),
  taggedInterested: num(row.autoTaggedInterested),
  totalTagged: num(row.totalAutoTagged),
  messageReplyRate: num(row.messageReplyRate),
  inmailReplyRate: num(row.inMailReplyRate),
  connectionAcceptanceRate: num(row.connectionAcceptanceRate),
  interestedRate: num(row.autoTaggedInterestedRate),
});

/** A date window. Both ends or neither — HeyReach rejects one alone. */
export type StatsWindow = { startDate?: string; endDate?: string };

const window = (range: StatsWindow): Row =>
  range.startDate && range.endDate ? { startDate: range.startDate, endDate: range.endDate } : {};

/**
 * Workspace totals, optionally narrowed to campaigns, senders or a date window.
 *
 * `byDayStats` is dropped. It is a zero-filled entry per day since the account opened — several
 * thousand lines of mostly nothing, which once cost this project a two-thousand-line terminal dump
 * and would cost far more inside a model's context. Anything that genuinely needs a daily series
 * should read our own `rr_messages`, which is both smaller and ours.
 */
export async function overallStats(
  apiKey: string,
  filters: { campaignIds?: string[]; accountIds?: string[] } & StatsWindow = {},
): Promise<HeyReachMetrics> {
  const payload = object(
    await call(apiKey, "stats/GetOverallStats", {
      campaignIds: filters.campaignIds ?? [],
      accountIds: filters.accountIds ?? [],
      ...window(filters),
    }),
  );
  return metrics(object(payload.overallStats));
}

/** The same metrics, one row per campaign. The only way to compare campaigns on HeyReach's own numbers. */
export async function statsByCampaign(
  apiKey: string,
  filters: { campaignIds?: string[]; accountIds?: string[] } & StatsWindow = {},
): Promise<Array<HeyReachMetrics & { campaignId: string; campaignName: string; deleted: boolean }>> {
  const payload = object(
    await call(apiKey, "stats/GetOverallStatsByCampaign", {
      campaignIds: filters.campaignIds ?? [],
      accountIds: filters.accountIds ?? [],
      ...window(filters),
    }),
  );
  return list(payload.overallStats)
    .map(object)
    .map((row) => ({
      campaignId: text(row.campaignId),
      campaignName: text(row.campaignName),
      deleted: row.isCampaignDeleted === true,
      ...metrics(row),
    }));
}

/* ── Inbox ───────────────────────────────────────────────────────────────────────────────────── */

export type HeyReachMessage = { from: "lead" | "us"; body: string; sentAt: string };

/** HeyReach labels both a conversation and each message with `ME` or `CORRESPONDENT`. */
const speaker = (value: unknown): "lead" | "us" => (text(value).toUpperCase() === "ME" ? "us" : "lead");

export type HeyReachConversation = {
  id: string;
  senderId: string;
  senderName: string;
  leadName: string;
  leadProfileUrl: string;
  leadLinkedInId: string;
  lastMessageAt: string;
  /**
   * `"lead"` or `"us"` — how you tell "they replied" from "we followed up".
   *
   * Translated from HeyReach's own `"CORRESPONDENT"` and `"ME"`. Passed through verbatim those two
   * words are a puzzle: "ME" is whichever sending account happened to own the thread, not the reader,
   * and "CORRESPONDENT" is nobody's word for a prospect. Our own tables already say inbound/outbound,
   * so one vocabulary is used throughout.
   */
  lastMessageFrom: "lead" | "us";
  lastMessage: string;
  messageCount: number;
  read: boolean;
  messages: HeyReachMessage[];
};

const conversation = (row: Row): HeyReachConversation => {
  const correspondent = object(row.correspondentProfile);
  const account = object(row.linkedInAccount);
  return {
    id: text(row.id),
    senderId: text(row.linkedInAccountId),
    senderName: [text(account.firstName), text(account.lastName)].filter(Boolean).join(" "),
    leadName: [text(correspondent.firstName), text(correspondent.lastName)].filter(Boolean).join(" "),
    leadProfileUrl: text(correspondent.profileUrl),
    leadLinkedInId: text(correspondent.linkedin_id),
    lastMessageAt: text(row.lastMessageAt),
    lastMessageFrom: speaker(row.lastMessageSender),
    lastMessage: text(row.lastMessageText),
    messageCount: num(row.totalMessages),
    read: row.read === true,
    messages: list(row.messages)
      .map(object)
      .map((message) => ({
        from: speaker(message.sender),
        body: text(message.body ?? message.text ?? message.message),
        sentAt: text(message.createdAt ?? message.sentAt ?? message.time),
      })),
  };
};

/** The filters `GetConversationsV2` accepts. Flat here; nested into `filters` before they are sent. */
export type ConversationFilters = {
  campaignIds?: string[];
  linkedInAccountIds?: string[];
  /** Mutually exclusive with `leadLinkedInId` — HeyReach honours one identifier, not both. */
  leadProfileUrl?: string;
  leadLinkedInId?: string;
  /**
   * Matches the correspondent's **name**. Not the message text — this is the second trap on this
   * endpoint and it is worse than the first, because a text search that returns nothing looks like an
   * answer. Probed on a live account: `"thanks"` returns 0 conversations although it appears in the
   * bodies, while `"Maria"` returns 10, `"Tsambarlis"` returns 1, and the single letter `"a"` returns
   * 1,568 of 1,901 — the behaviour of a case-insensitive substring match against a name and nothing
   * else. There is no way to search message content through this API.
   */
  searchString?: string;
  /** `false` for unread. Probed: `false` → 1, `true` → 1,900, unset → 1,901. */
  seen?: boolean;
};

/**
 * Conversations, with their messages already inside them.
 *
 * **This is the function that exists because of the `filters` trap.** HeyReach ignores flat filter
 * params and returns the whole inbox at HTTP 200, so the nesting is done here, once, where it cannot
 * be forgotten. See the file header for the 552-vs-1901 measurement.
 *
 * `limit` is capped at 100 per page by HeyReach and `max` bounds the total, because this endpoint
 * will happily walk 1,901 conversations and no answer is improved by all of them.
 */
export async function conversations(
  apiKey: string,
  filters: ConversationFilters = {},
  max = 50,
): Promise<Page<HeyReachConversation>> {
  const active = Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== "",
    ),
  );
  const page = await paged(apiKey, "inbox/GetConversationsV2", { filters: active }, max);
  return { items: page.items.map(conversation), total: page.total };
}
