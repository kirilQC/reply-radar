# 4. Issues, root causes and fixes

Every real bug this project has hit, why it happened, and what changed. Read this before touching
deletion, dedupe, message direction, or the origin classifier.

Grouped by area, not chronology. Each entry names the underlying mistake, because the same mistake
tends to reappear somewhere new.

---

## Deletion

### A deleted lead stayed in the inbox

**Reported as:** "when I delete a lead from the database, it actually still keeps them in the inbox."

**Two independent causes, both real:**

1. **The delete and the drawer disagreed about what "a lead" is.** The drawer merges every `rr_leads`
   row sharing `linkedin_profile_url` into one person. The `DELETE` removed only the row that
   happened to be clicked. The same person therefore survived under another client — visibly, in the
   inbox.
2. **The delete never read its own responses.** It fired four `DELETE`s and returned `{ ok: true }`
   unconditionally. A delete blocked by a policy, a delete against a missing table, and a delete that
   removed 400 rows all looked identical.

**Fix:** `app/lib/lead-deletion.ts`. `relatedLeadIds()` makes deletion person-scoped;
`deleteLeadsCompletely()` deletes children explicitly, counts rows via
`Prefer: return=representation`, then **reads the tables back** and throws if anything survived. The
route returns `502` with the survivor counts.

**The generalisable lesson:** a `204` from PostgREST tells you nothing. If a mutation's success
matters, ask for what it changed and verify.

### Third-order effect: undismissable "Unknown lead" cards

Found while investigating the above. `GET /api/inbox` listed conversations by `workspace_id` and never
checked that the lead row still existed. Conversations orphaned by an earlier partial delete rendered
as an "Unknown lead" card with no way to dismiss it — which is *also* how a deleted lead appeared to
survive deletion.

**Fix:** an explicit `leadById.has(...)` guard in the inbox filter. Orphans are dropped and logged
(`reply_radar_inbox_dropped_orphaned`), which also clears the wreckage of past failed deletes without
waiting for a purge.

### `on delete cascade` cannot be trusted

`supabase/schema.sql` declares cascades. Whether they exist in a given database depends on which
migration actually ran. The code cannot see that.

**Fix:** delete children explicitly, in order: `rr_scores` → `rr_messages` → `rr_conversations` →
`rr_leads`.

### `rr_scores` may not exist

The checked-in schema declares it; production may not have it. A `DELETE` returned `404` and threw,
failing the whole deletion.

**Fix:** `tolerateMissingTable: true` on that one call — `404` becomes `0`, any other failure still
throws. Reasoning: a table that isn't there holds no rows to orphan, so a 404 is a legitimate no-op.
Proved by running the harness with the table absent (`NO_SCORES=1`).

---

## Message identity and direction

### Our own outreach appeared as if the lead had written it

**Cause:** the worker kept its own copy of message-direction logic. The two implementations
disagreed about who sent a message, so the same message was stored **twice, under opposite
directions**, and QC Growth's outbound showed up in the inbox as an inbound reply.

**Fix:** `shared/message-identity.mjs`, loaded by both the app and the worker. This is why
`shared/` exists at all, and why duplicating logic across the `.mjs`/TypeScript boundary is a
standing prohibition rather than a style preference.

### A refresh discarded AI work

HeyReach returns the same message from a webhook and again from a history refresh. Naive dedupe kept
whichever arrived last, throwing away the row that already carried a cached draft or a sentiment.

**Fix:** `app/lib/message-dedupe.ts` prefers the row with AI state, then prefers a non-`refresh`
source. Extracted verbatim from the inbox route so the purge sees the same collapsed threads.

### Merge replaced instead of annotating

`mergeConversationMessages` keeps the **API history row canonical** (it carries the real message id)
and stores the webhook copy at `raw.webhook_message`. A test asserted the opposite — that the webhook
row won — and had been failing silently because the `npm test` script only ran a starter-template
test. The test's assertion was stale; the behaviour is correct and intentional. The test now asserts
both halves: history survives, and the webhook payload is preserved beside it.

**The generalisable lesson:** a test script that doesn't run the tests is worse than no tests.

---

## The origin classifier

### The loose history check misclassified every legacy row

First attempt:

```js
if (historyStatus && historyStatus !== "complete") return unknown;   // WRONG
```

Rows written before ingestion started stamping `history_status` have **no** value, so this guard let
them through and the classifier confidently decided who spoke first from a partial thread. Every
legacy row was at risk of being excluded as lead-initiated.

**Fix:** require positive confirmation.

```js
if (historyStatus !== "complete") return unknown;   // correct
```

**The generalisable lesson:** for a guard protecting an irreversible action, absence of a warning is
not the same as confirmation of safety.

### Campaign attribution has to win over message order

Some campaigns open with a connection request rather than a message. The lead's first *message* is
then genuinely inbound — but they are still someone we went out and found. Judging by message order
alone excluded real outbound leads.

**Fix:** any HeyReach campaign on any message in the thread → `outbound`, checked **before** message
ordering. Campaign presence is the decisive signal.

### Why the verdict is never stored

Deliberate. Deriving it every time means correcting a rule immediately re-includes anyone it had been
excluding. A stored flag would need a backfill, and a later fix could no longer reach the rows the
earlier bug had already written.

---

## The worker

### `Unexpected end of JSON input`

The worker called `response.json()` on an HTML error page.

**Fix:** every worker fetch checks status and content type before parsing, and logs the response text
on failure. `appPost` also carries a 90-second `AbortSignal.timeout`.

### `rr_sync_runs` schema mismatch, twice

First `run_type` did not exist; then it existed but was `NOT NULL`. Both crashed the worker on
startup.

**Fix:** match the real table. **Do not** write speculative migrations that assume columns — inspect
Supabase first.

### `APP_BASE_URL` without a scheme broke the whole sweep

A value like `replyradar.app` produced an unparseable URL, and the failure surfaced as if the AI
sweep itself were broken.

**Fix:** the scheme is assumed rather than demanded. `https://` is prepended when missing; a value
that is still unparseable logs `reply_radar_app_base_url_invalid` and disables only the sweep, so the
diagnosis points at configuration instead of at the sweep.

### One client's backlog starved every other client

The sweep restarted at the first client each cycle. With a large enough backlog at that client, no
other client was ever reached.

**Fix:** `aiWorkspaceCursor` remembers where the budget ran out and the next cycle resumes there.

### A long sweep made the app look dead

`AI_CYCLE_BUDGET_SECONDS` is 600 by default, longer than the health page's freshness threshold.

**Fix:** the sweep re-stamps `rr_sync_runs` as it goes.

### AI Ark retries were burning money

AI Ark bills five attempts per call. Retrying a lead it could not match, every two minutes, spent
real money re-learning the same answer.

**Fix:** failed enrichment is left alone for seven days.

---

## PostgREST

### `414 Request-URI Too Large`

PostgREST filters live in the URL, so a long `id=in.(...)` took the endpoint down.

**Fix:** `app/lib/chunk-query.ts` batches ids. Batches are also kept small enough that one response
stays under the default 1000-row ceiling — 20 conversation ids can easily exceed 1000 messages, so
message reads page **within** each batch as well.

### Paging by timestamp skipped and repeated rows

Paging `rr_conversations` by `last_message_at` revisits or skips rows wherever two conversations share
a timestamp. In an irreversible purge that is unacceptable.

**Fix:** page by `id`, which is unique.

### An "all-time total" that was silently capped

The home page's reply count was being read from `/api/analytics`, which pages through HeyReach and
caps conversations at `limit=1000` per 20-id batch. The number was wrong and looked authoritative.

**Fix:** `/api/analytics/summary`, built entirely from `count=exact` queries. Nothing is fetched,
nothing is truncated.

**The generalisable lesson:** a total taken from a paginated fetch is a page size wearing a total's
clothes.

---

## Frontend

### `dashboard.css` ordered sections by position

```css
.dashboard-home > section:first-of-type { order: 2; }
.dashboard-home > section:nth-of-type(2) { order: 1; }
```

Inserting a section anywhere in the markup silently reshuffled the entire page. This is also why
"Performance overview" was rendering at the top when nobody had asked it to.

**Fix:** named classes with explicit `order` — `.dashboard-stats-section{order:0}`,
`.dashboard-insights{order:1}`, `.dashboard-profiles-section{order:2}`,
`.dashboard-clients-section{order:3}`. Done **before** adding the new section, not after.

### "50 loaded" described the fetch, not the data

The lead database heading reported the page size. Operators read it as the database total.

**Fix:** an exact `count=exact` total that follows the active filters, with wording that changes
accordingly — `"91,500 total leads in the database"` vs `"37 matching leads"`.

### `jsx-a11y/no-autofocus`

**Fix:** `useRef` + `useEffect` calling `.focus()`, not the `autoFocus` prop.

### Nested buttons

A clickable card containing a delete button produced invalid HTML.

**Fix:** card wrappers are `<div role="button">`, so the nested `<button>` stays valid.

### The sidebar flickered from empty to populated

**Fix:** render a stable loading state or the last-known client list; never render an empty list
before the fetch resolves.

---

## Deployment

### HeyReach's Test Webhook returned an HTML 404

`https://replyradar.app/api/webhooks/heyreach/<slug>` returned the marketing site's 404 while the
`.vercel.app` URL worked — meaning `replyradar.app` was pointed at a different or stale Vercel
project.

**Two requirements this produced:** the webhook route must answer `GET`, `HEAD` **and** `POST` with
JSON, because HeyReach probes before saving; and when only the custom domain fails, suspect domain
assignment, not the route.

### Demo data reaching production

Placeholder client names and hardcoded counts ("Priority inbox", `Hot 4`, `12`) shipped once.

**Fix / standing rule:** no placeholder names, counts or dates, ever. Grep before release.

---

## Process notes

- **Baseline lint is exactly 6 errors** (plus warnings). Check against 6 after every change; see
  `05-conventions-and-gotchas.md` for the exact list. Any seventh error is yours.
- **Explore/Agent subagents fail with "Prompt is too long"** in this repo's context. Use `Grep` and
  `Read` directly.
- **Kill the port before every harness run.** `SIGKILL` on `npm start` can leave the child listening:
  `lsof -ti tcp:<port> | xargs -r kill -9`.
