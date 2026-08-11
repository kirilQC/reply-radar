# 8. Session handoff — state as of `59b4ba4`

Written at the end of the session that produced `ed9f9b2`, `17211f6` and `59b4ba4`. Read this for
**where the project actually stands right now**; read `01`–`07` for how the system works.

Everything in this file was true at `59b4ba4` on `main`. If `git log` shows commits after that, trust
`git log`.

---

## Where things stand

`main` is clean, pushed, and everything is green:

```
npm run typecheck   # clean
npm run lint        # 59 problems, exactly 6 errors — the baseline, see 05
npm test            # 10 passing
npm run build       # compiles
```

Pages that answer `200` on a production build: `/`, `/inbox`, `/admin`, `/database`, `/health`,
`/analytics`, `/calendar`, `/profiles`, `/reports`.

**The heartbeat page is `/health`, not `/heartbeat`.** I lost a minute to that; the docs call the
feature "heartbeat" throughout, but the route is `/health`.

## What shipped, most recent first

| Commit | What it did |
|---|---|
| `59b4ba4` | Removed the home page's "Performance overview" section. |
| `17211f6` | Deleted the starter-template remains; wrote `CLAUDE.md` and this `context/` folder. |
| `ed9f9b2` | Exact totals on the home page and the lead-database heading. |
| `6de4402` | Person-scoped lead deletion with read-back verification; the inbound-first purge. |
| `8a308a1` | Vetted scoring defaults for unconfigured clients; the shared prompt library. |
| `a16ed42` | Lead-initiated conversations dropped from the inbox rather than set aside. |
| `0eb2dca` | The version of the above that set them aside — **reversed by `a16ed42`**, see `06`. |
| `8085671` | Accept an `APP_BASE_URL` typed without its scheme. |
| `f57b7c9` | Analyse every reply in the background, not only unanswered ones. |

### `59b4ba4` in detail

The five exact stat tiles made the charts redundant:

> "can we get rid of the perfromance review from the dashboard since we now have those replies boxes
> on the homepage."

Gone: the `<section className="dashboard-insights">` markup (reply-volume line chart, queue-mix donut,
workspace snapshot), plus its `analytics` state, its `DashboardAnalytics` type and its `/api/analytics`
fetch — all dead once the section left. In `dashboard.css`, the `.dashboard-insights` rules went and
the remaining orders were renumbered to stats → profiles → clients.

Two things worth knowing about this change:

1. It took `/api/analytics` **off the home-page load path**, which is a real saving — that route pages
   through HeyReach. The route still exists for other callers; only the home page stopped calling it.
2. **The chart CSS was deliberately left in place.** `app/page.tsx` (the inbox) uses `donut-chart`,
   `chart-area`, `chart-line` and `chart-axis`, and those live inside the *same one-line minified
   blocks* as the removed section's classes. Editing minified CSS surgically is risk with no payoff.
   If you are tempted to tidy it, grep the inbox first.

### `17211f6` in detail, because the diff looks alarming

The commit reports **9,387 deletions**, which prompted:

> "woah it says you deleteded 9.3k rows of code. are you sure you didnt delete anything important or
> anything that would break the front end or backend?"

The honest accounting, which is the useful part:

| | Lines |
|---|---|
| `package-lock.json` | 8,310 |
| One unused starter CSS file | 326 |
| Everything else, 22 files | 751 |
| **Live source, untouched** | **11,437** |

Nothing load-bearing went. The method that made that safe: inventory every candidate, grep the whole
repo for references, and **delete only what is referenced solely by other dead files.** That method is
also what stopped two mistakes:

- **Tailwind looked like starter cruft but is live** — imported in `globals.css` and using utilities in
  8 `.tsx` files. Kept.
- **`worker/job-queue.ts` and `worker/watchdog.ts` had passing tests**, which argues for keeping them,
  but the code is unwired stubs (`reconcileWorkspace` returns zeros) and `eventKey` was superseded by
  `app/lib/heyreach-ingestion.ts:114`. Deleted with their tests.

Deleted: `app/_sites-preview/*`, `app/chatgpt-auth.ts`, `build/sites-vite-plugin.ts`, `vite.config.ts`,
`db/*`, `drizzle.config.ts`, `drizzle/meta/_journal.json`, `examples/d1/**`,
`types/cloudflare-workers.d.ts`, `.openai/hosting.json`, `worker/{index,job-queue,reconciliation,watchdog,heyreach-client}.ts`,
`tests/{rendered-html,reply-radar-core}.test.mjs`, and 3 unused starter SVGs from `public/`.
`public/favicon.svg` and `public/qc-growth-logo.png` **are** referenced and were kept.

Dependencies removed: `drizzle-orm`, `drizzle-kit`, `react-loading-skeleton`,
`@cloudflare/vite-plugin`, `@vitejs/plugin-react`, `@vitejs/plugin-rsc`, `react-server-dom-webpack`,
`vinext`, `vite`, `wrangler`. The `db:generate` script went with them.

## Two discoveries from that cleanup that outlive it

**`npm test` had never run the real suite.** The old script only ran a starter test. Fixing it to
`node --test tests/*.test.mjs` immediately surfaced a failure in
`tests/heyreach-conversation.test.mjs`: it expected `merged[0].raw.reply_radar.source === "webhook"`
but got `"history"`.

**The assertion was stale, not the code.** `mergeConversationMessages`
(`app/lib/heyreach-conversation.ts:124-139`) intentionally keeps the API history row canonical because
it carries the real message id, and attaches the webhook copy at `raw.webhook_message` so nothing is
lost. The test now asserts both halves. The lesson: a test that has never executed is not a test.

**Next 16 serves CSS from `/_next/static/chunks/*.css`, not `/_next/static/css/`.** My first
verification grepped the old path, found zero stylesheets, and reported "tailwind utilities in bundle:
0" — which looked like I had broken the front end. I hadn't; the check was wrong. Corrected, it found
2 stylesheets, both `200`, 47,411b and 96,337b, containing `dashboard-stat-tile`, `tabular-nums`,
`dashboard-stats-section` and Tailwind's `box-sizing:border-box` preflight. **If a verification result
looks catastrophic, suspect the verification first.**

## How this session verified things

The pattern is in `07-verification.md`; what follows is what it looked like in practice.

For `ed9f9b2` the assertions that carried the weight were about **the PostgREST query strings the
route emitted**, not the JSON it returned — a stub returns whatever you tell it to, so response checks
prove almost nothing. `summary-stats.mjs` ended at **17/17**, including the two added for the lead
heading:

```js
["the lead heading reports the database total, not the page size",
  dbUnfiltered.totalLeads === 91_500 && dbUnfiltered.filtered === false],
["searching switches the heading to a filtered count",
  dbSearched.filtered === true && typeof dbSearched.totalLeads === "number"],
```

For the cleanup, a passing build was **not** treated as sufficient, because "it compiles" does not
answer "would this break the front end". Instead: zero dangling references across all remaining
source, all 9 pages fetched and `200`, both CSS bundles loaded and inspected, all 4 harnesses re-run
and passing, `node --check` on the worker, and both `shared/*.mjs` imported cleanly.

Harnesses live in `/tmp/rr-harness/` and are **deliberately uncommitted** — they hardcode ports and an
absolute `cwd`. `/tmp` does not survive a reboot; recreate them from the pattern in `07`. Always
`lsof -ti tcp:<port> | xargs -r kill -9` first, because `SIGKILL` on `npm start` leaves the child
listening and you will otherwise debug a stale server.

## Pending and unresolved

**Watch the first deploy after `17211f6`.** It changed `package.json` and `package-lock.json`, so
Vercel and Render both do a fresh install. If either build fails, it is the dependency removal — revert
only those two files; the file deletions are independent of them. This had not yet been confirmed when
the session ended.

**An unanswered request from much earlier, truncated mid-sentence:** "i also want to make it a little
easier for my teammates trying to…". The shared prompt library in `8a308a1` may have been the intent,
but it was never confirmed. Worth asking rather than guessing.

**Open questions, both untouched:**

- Should the worker's `APP_BASE_URL` point at `replyradar.app` rather than the `.vercel.app`
  deployment? Never answered.
- Subdomain analytics needs `ROOT_DOMAIN`, wildcard DNS, and the wildcard domain added in Vercel. None
  of it is configured.

## If you are picking this up cold

Read `CLAUDE.md` first — it loads automatically and lists the eight things that catch everyone out.
Then `04-issues-and-fixes.md`, which is where the expensive lessons are, and `06-product-decisions.md`
before proposing any UI change, because several obvious-looking ideas have already been rejected.

The three that will bite you fastest: **`app/page.tsx` is the inbox, not the home page**;
**`supabase/schema.sql` has drifted from production**, so check the real columns before writing a
query; and **a lead is a person, not a row**, so anything lead-scoped must span every `rr_leads` row
sharing a `linkedin_profile_url`.
