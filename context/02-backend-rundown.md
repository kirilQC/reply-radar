# 2. Backend rundown

How the server side actually works, end to end.

## PostgREST conventions

Every database call is a `fetch`. There is no Supabase client library and no ORM. The pattern:

```ts
const auth = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}` });

await fetch(`${url}/rest/v1/rr_leads?select=id,name&workspace_id=eq.${id}&order=created_at.desc&limit=50`, {
  headers: auth(key),
  cache: "no-store",       // always: route handlers must not cache Supabase reads
});
```

`cache: "no-store"` is on every Supabase fetch. Without it Next will happily serve a stale inbox.

### Exact counts without fetching rows

`app/lib/rest-count.ts`:

```ts
export async function countRows(url: string, key: string, path: string): Promise<number | null> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { ...auth(key), Prefer: "count=exact", Range: "0-0" },
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return null;
  const total = Number(String(response.headers.get("content-range") ?? "").split("/")[1]);
  return Number.isFinite(total) ? total : null;
}
```

PostgREST answers with `206`, an empty array, and `Content-Range: 0-0/4242`. The total is real,
uncapped, and no rows crossed the wire.

It returns `null` rather than throwing **on purpose**: a stat that cannot be counted should render as
`—`, not take the page down.

Used by `/api/analytics/summary` (all seven home-page numbers) and `/api/database/leads` (the
heading total).

### Deletes must ask for what they deleted

```ts
Prefer: "return=representation"
```

PostgREST then returns the deleted rows, so `data.length` is the number actually removed. Without
this, a `DELETE` blocked by a policy and a `DELETE` that removed 400 rows look identical — both are
`204`. This was the root cause of a real bug; see `04-issues-and-fixes.md`.

### `in.(...)` filters must be batched

`app/lib/chunk-query.ts` exists because PostgREST filters live in the URL. A long `id=in.(...)`
returns a **414** and takes the endpoint down. Batches are also kept small enough that one response
stays under PostgREST's default 1000-row ceiling, which matters when each id fans out to many rows —
20 conversation ids can easily exceed 1000 messages, so message reads page **within** each batch too.

### Paging must order by something unique

Page by `id`, not by `last_message_at`. Ordering by a timestamp revisits or skips rows wherever two
records share a value. `app/api/database/purge/route.ts` documents this inline.

## The route handlers

### Ingestion

**`POST /api/webhooks/heyreach/[workspaceId]`** and the `[workspaceId]/[secret]` variant.

- `GET` and `HEAD` answer HeyReach's "Test Webhook" button with JSON, because HeyReach probes the URL
  before it will save it. If these return HTML, HeyReach reports a 404 and refuses the URL.
- The `[secret]` segment exists purely for URL compatibility. **It is not validated.** Out of scope.
- Recognises HeyReach's synthetic validation payload (a lead literally named `TestId` / `John Doe`)
  and does not persist it as a real lead. See `isHeyReachValidationPayload`.
- Writes `rr_webhook_events` with a deterministic `event_key`, so a redelivered webhook does not
  double-process. The key is the HeyReach `correlation_id` when present, otherwise
  `conversationId|leadId:timestamp`. Built in `app/lib/heyreach-ingestion.ts`.

**`POST /api/conversations/refresh`** pulls a thread's full history from HeyReach and merges it with
what is stored, via `mergeConversationMessages` in `app/lib/heyreach-conversation.ts`.

On a near-duplicate (same body within `NEAR_DUPLICATE_MS`), the **API history row stays canonical**
because it carries the real message id; the webhook copy is preserved beside it at
`raw.webhook_message` so nothing the webhook knew is lost. The merge is not a replace.

### Reading the inbox

**`GET /api/inbox`** does three things beyond fetching:

1. **Deduplicates** via `dedupeMessages` from `app/lib/message-dedupe.ts`. HeyReach can return the
   same message from a webhook and again from a history refresh. The survivor is chosen by
   preferring a row that already carries AI state (so a re-fetch never discards a draft or a
   sentiment), then preferring a non-`refresh` source.
2. **Drops orphaned conversations** — those whose `rr_leads` row no longer exists. These used to
   render as an "Unknown lead" card that could not be dismissed.
3. **Drops lead-initiated conversations** using `classifyConversationOrigin`. Both exclusions are
   logged server-side (`reply_radar_inbox_dropped_orphaned`) and **never surfaced in the UI** — see
   `06-product-decisions.md`.

### Who started the conversation

`shared/conversation-origin.mjs` → `classifyConversationOrigin({ messages, leadRawData })` returns
`{ origin: "outbound" | "inbound_lead" | "unknown", reason }`.

It is written to **abstain rather than guess**, because wrongly excluding a real outbound lead hides
a live deal, which is far more expensive than an extra row in the inbox. The order of the rules is
load-bearing:

1. **Any HeyReach campaign attribution on any message → `outbound`**, whatever the messages say.
   This saves campaigns whose first touch is a connection request rather than a message: the lead's
   first *message* really is inbound, but they are still someone we went out and found. Campaign
   presence is the decisive outbound signal.
2. **`leadRawData.reply_radar.history_status !== "complete"` → `unknown`.** Positive confirmation is
   required, not merely the absence of a warning. Ingestion stamps `history_status` on every lead it
   writes, so a row without it was written by something older. See `04-issues-and-fixes.md` — the
   looser check misclassified every legacy row.
3. Any unparseable `sent_at` → `unknown`.
4. First message by time is `outbound` → `outbound`; otherwise → `inbound_lead`.

**Nothing is stored.** The verdict is derived every time it is needed, so fixing a rule immediately
re-includes anyone it had been excluding. No backfill, no stale flag on a row a later fix cannot
reach.

### The AI routes

All of these are called by both the browser and the worker.

| Route | Does |
|---|---|
| `POST /api/conversations/sentiment` | Classifies an inbound message, writes `sentiment` + `analyzed_at`. |
| `POST /api/ai/draft` | Writes a reply in the client's voice; caches `cached_draft` + `cached_reason`. |
| `POST /api/ai/icp-score` | Scores the lead; writes `icp_score`, `icp_reason`, `icp_scored_at`. |
| `POST /api/ai/follow-up-score` | Scores the thread's urgency; writes `followup_urgency`, `followup_reason`, `followup_analyzed_at`. |
| `POST /api/ai/enrich` | AI Ark lookup; writes `ai_ark`, `enrichment_status`. |
| `/api/ai/config` | Per-client AI settings. |
| `/api/ai/templates` | The **shared, named prompt library**, saved by any teammate from a ＋ button. |
| `/api/ai/audit` | Prompt change trail. |

The two scoring routes use `max_tokens: 100`, `temperature: 0`, and a 10-second timeout. They are
classifiers, not writers; determinism matters more than prose.

**Scoring works before anyone configures anything.** `app/lib/scoring-templates.ts` defines vetted
templates, with `DEFAULT_ICP_TEMPLATE_ID = "general-seniority"` and
`DEFAULT_FOLLOW_UP_TEMPLATE_ID = "awaiting-us"`. The routes apply these defaults **even while the ICP
panel is locked**, so a newly added client is scored from day one rather than silently skipped. The
client brief is threaded into the ICP prompt *above* the criteria.

## The Render worker

`worker/render-worker.mjs`, ~560 lines of plain ESM. One infinite loop:

```
main()
  └── for (;;)
        runOnce()
        sleep(POLL_INTERVAL_SECONDS, floor 30)
```

`runOnce()` in order:

1. Write a `running` heartbeat row to `rr_sync_runs` (`run_type: "heartbeat"`, `workspace_id: null`).
2. For each client in `rr_workspaces` ordered by `created_at`: `syncWorkspace` — check the HeyReach
   key works, record the result.
3. Write the `success` heartbeat row.
4. **Every 24 hours** (`REFRESH_INTERVAL_MS`): `refreshAllConversations`, in batches of 20.
5. **Every cycle**: `runAiPipeline`.

Each step is individually wrapped in try/catch and logged with a `reply_radar_*` event name, so one
client's broken key cannot stop the cycle.

### The AI sweep

```
runAiPipeline()
  for each client, starting at aiWorkspaceCursor
    conversationsNeedingAi(workspace)      // newest 200 replies missing AI state
    take AI_BATCH_SIZE (10)
    run AI_CONCURRENCY (4) at a time:
       runAiForConversation()
         → POST /api/ai/enrich            (only if needsEnrichment(lead))
         → POST /api/conversations/sentiment
         → POST /api/ai/draft
         → POST /api/ai/icp-score
         → POST /api/ai/follow-up-score
    if elapsed > AI_CYCLE_BUDGET_MS: remember this client's slug and stop
```

Design points that exist for a reason:

- **`aiWorkspaceCursor`** is module-level state remembering which client the previous cycle ran out
  of budget on. Without it, a large backlog at the first client would starve every other client
  forever.
- **The sweep re-stamps `rr_sync_runs`** while it runs, so a long sweep does not make the health page
  report the worker as stale.
- **`APP_BASE_URL` tolerates a bare hostname.** A missing `https://` used to make the whole sweep
  look broken; the scheme is now assumed rather than demanded, and a genuinely unparseable value logs
  `reply_radar_app_base_url_invalid` and disables only the sweep.
- **`appPost` uses a 90-second `AbortSignal.timeout`** and checks `response.ok` before reading. Every
  worker fetch must check status and content type before `response.json()` — `Unexpected end of JSON
  input` from an HTML error page has bitten this worker before.
- **Failed enrichment is left alone for 7 days.** AI Ark bills five attempts per call, so retrying
  every two minutes spends real money re-learning the same answer.

### `refreshConversation`

Pulls a thread's history from HeyReach and merges. Rows written by refresh are stamped
`raw_data.reply_radar.source = "refresh"`, which is exactly what `dedupeMessages` uses to prefer the
original over the re-fetch.

## Deletion

`app/lib/lead-deletion.ts` is the only correct way to delete a lead. Three ideas:

### `relatedLeadIds(url, key, leadId)`

The lead drawer shows **one merged person assembled from every `rr_leads` row sharing their LinkedIn
profile URL** (a person appearing under three clients is three rows). So deletion is **person-scoped,
not row-scoped**. Deleting only the clicked row left the same person visible under another client,
which is precisely the "I deleted them and they're still there" report.

### `deleteLeadsCompletely` / `deleteConversationsCompletely`

Children are deleted **explicitly**, in order: `rr_scores` → `rr_messages` → `rr_conversations` →
`rr_leads`. `on delete cascade` is *not* trusted, because whether it exists is a property of
whichever migration actually ran in that database — something this code cannot observe.

`rr_scores` is deleted with `tolerateMissingTable: true`: a `404` becomes `0`. The checked-in schema
declares the table but it may not exist. A table that isn't there holds no rows to orphan, so a 404
is a legitimate no-op. Any other failure still throws.

### Read-back verification

After deleting, the tables are read again. If anything survived:

```
throw new Error(`Delete did not finish: ${n} lead row(s) and ${m} conversation(s) are still present.`)
```

which the route turns into a `502`. A delete that silently did nothing is now impossible to mistake
for success.

## The purge

`POST /api/database/purge` removes cold-inbound and orphaned conversations across the whole database.

- **Two phase.** `{}` returns a dry run with counts and 12 sample names. `{ confirm: true }` performs
  the delete. Counting and deleting run against the same scan, so the numbers on screen are the rows
  that will actually go rather than an estimate taken at a different moment.
- Bounded at `MAX_CONVERSATIONS_PER_RUN = 4_000`, paging `PAGE = 1_000` at a time ordered by `id`,
  returning `hasMore` so it can be run again.
- Uses **`dedupeMessages` before classifying**. This is a prerequisite, not a nicety: an irreversible
  mass delete must judge "who spoke first" from the same collapsed thread the inbox uses, or a
  duplicated outbound greeting reads as the lead having opened the conversation.
- **A lead row is only deleted when *every* conversation of theirs was lead-initiated.** If they also
  have a thread we opened, only the cold thread goes. A genuine outbound lead is never thrown away.
- Logs `reply_radar_purge` with the resulting counts.

## Home-page totals

`GET /api/analytics/summary` is **deliberately separate** from `GET /api/analytics`. The latter calls
HeyReach, pages through every message, and caps conversations at 1,000 per batch — fine for the
analytics screen, wrong for a number that claims to be an all-time total.

Everything in `/api/analytics/summary` is a `count=exact` query. Seven counts run in one
`Promise.all`: today, yesterday, this week, this month, all time, clients, leads.

### Time-zone boundaries, without a library

`?timeZone=America/New_York` comes from the reader's saved preference.

```ts
offsetAt(instant, zone)   // format the instant into the zone, re-parse as UTC, subtract → the offset
localDate(instant, zone)  // { year, month, day, weekday } in that zone
startOfLocalDay(y, m, d, zone)  // resolves the offset TWICE
```

The double resolution is the subtle part: the first guess measures the offset at the wrong moment.
On the two days a year daylight saving moves, the offset at midday differs from the offset at
midnight, and using the wrong one shifts the boundary by an hour.

- Weeks start **Monday**: `daysSinceMonday = (weekday + 6) % 7`.
- "Yesterday" is a **closed range** (`gte` *and* `lt`), so it doesn't silently mean "everything since
  yesterday".
- An **unusable time zone falls back to UTC** rather than throwing. A stale saved preference must not
  500 the home page.
- `monthLabel` and `weekStart` are returned so labels name the real period instead of guessing at the
  server's locale.

Verified against the actual query strings the route emits — see `07-verification.md`.

## The lead-database heading

`GET /api/database/leads` returns `totalLeads` and `filtered`.

The count **follows the filters**, so the label never lies. When sender/campaign/time-range filters
are active they are applied in memory, and the filtered set in hand *is* the answer, so `rows.length`
is used. Otherwise the database is asked, because paging only ever sees one page. The cursor is
excluded either way: it narrows to "older than this page", which is a paging detail, not something
the reader is filtering by.

The heading then reads `"91,500 total leads in the database"` or `"37 matching leads"`.
