# 8. Session handoff — state as of `8e8f90a`

Read this for **where the project actually stands right now**; read `01`–`07` for how the system
works, and `09-morning-brief.md` for the feature that has taken up most of the recent sessions.

Everything here was true at `8e8f90a` on `main`. If `git log` shows commits after that, trust
`git log`.

The previous version of this file described the state at `59b4ba4` and is superseded; the parts of it
worth keeping (the `17211f6` cleanup accounting, the two lessons from it) are summarised under
*History worth keeping* at the bottom.

---

## Where things stand

`main` is clean and pushed. Green means:

```
npm test          # 341 passing, 0 failing   (morning-brief.test.mjs alone is most of that)
npm run typecheck  # clean
npm run lint       # exactly 18 errors, 67 warnings — the baseline
```

**The lint baseline is 18 errors and 67 warnings, not the 6 errors `05-conventions-and-gotchas.md`
originally recorded.** It grew with the Slack and brief work. Do not "fix" them as drive-by work and
do not add a nineteenth.

`npx next lint` is broken in this repo. Use `npx eslint .`. `npm test` prints a lot, so redirect it
and grep for `ℹ (pass|fail)`.

## The last several sessions, in one table

Newest first. All pushed.

| Commit | What it did |
|---|---|
| `8e8f90a` | Rule narrowed to 37 `=`, per-line centring, cascading sub-bullet indents. |
| `79161f6` | Heading fencing and centring moved into code; `Midweek Status:` title deleted. |
| `4412e40` | Fixed the Slack health panel's colours, order and three false readings. |
| `53da14a` | Extra Granola calls and extra Slack channels; the QC Brain as standing context; the automation log. |
| `dabcc77` | Never name a sender we cannot name; weekday reminder moved to the foot of the brief. |
| `3a4f476` | Real emojis, wider spacing, zero em dashes, spent campaigns dropped. |
| `3a34ee6` | The brief's shape rewritten against a hand-written version of the same brief. |
| `f7f5147` | The brief threaded under a header; each item checked against whether it is already done. |
| `47fea8a` | The brief made a list of owned work rather than a status report. |
| `33aa5ea` | Read Slack as a teammate, post as QC Bot. |
| `3f1c241` | The brief scheduled, and given the client's call. |

## The last round of requests, all shipped

Ten items, all in `53da14a` unless noted:

| Item | Where | Verified? |
|---|---|---|
| Extra Granola calls behind a plus button | `granola_extra_title_matches text[]` + `findClientCalls` + `ExtraRows` | needs the migration |
| Extra Slack channels behind a plus button | `slack_extra_channel_ids text[]` + `gatherChannels` | needs the migration |
| Main vs extra made explicit | prompt, user content, `MAIN ·` labels | tests |
| Bigger Slack hub cards | `.slack-hub` scoped override | in browser |
| Schedule behind an on/off switch and an "edit time and date" button | `app/slack/page.tsx` `scheduleOpen` | **not verified** |
| Exact time and date on "last brief sent" | `formatWhen` | in browser |
| Internal channel back as a destination inside Generate | `Destination` type + picker | tests |
| Every Slack automation run visible in System health | `/api/heartbeat` + `app/health/page.tsx` | in browser |
| The brief AI reading the client brief **and** the QC Brain | `brain-context.ts` + a trace step + prompt | tests |
| The Granola Test button listing every call it detects | `inspectNotes` + `GranolaKeysView` | **not verified** |

Then two rounds of Slack formatting on top of that (`79161f6`, `8e8f90a`) — see
`09-morning-brief.md`, which is where the reasoning lives.

## Open, and roughly in priority order

**The migration has not been run.** Until it is, extra channels and extra calls silently fail to
save. Paste it in the SQL editor:

```sql
alter table if exists rr_workspaces
  add column if not exists granola_extra_title_matches text[] not null default '{}';

alter table if exists rr_workspaces
  add column if not exists slack_extra_channel_ids text[] not null default '{}';
```

`supabase/schema.sql` and `supabase/migrations/20260818_morning_brief_extra_sources.sql` both already
carry them. The route reads with a two-select fallback, so a database without the migration still
writes briefs — it just writes them from the two channels and the one call.

**Willow has no per-sender rows in `rr_daily_stats`**, so its briefs say "3 senders" with no names.
Not a brief bug; the ingestion never wrote them.

**The worker sends scheduled briefs to the test channel.** `worker/render-worker.mjs:1289` defaults
`destination` to `"test"`, so an 8am scheduled brief lands in `#kiril-automation` rather than the
client's internal channel. Deliberate while the format was being tuned; now worth changing.

**`/invite @QC Bot`** into each client's internal and external channels — `canPost: false` on some.

**Other teammates' Granola keys** are not added, so their calls are invisible to the brief.

**The 60-second Hobby function ceiling** has not been re-measured since the brain fetch and the extra
transcripts were added to the brief route. There is a test asserting the route's own budget; the real
wall clock is untested.

**No UI for the per-client prompt override** (`morning_brief_prompt_<slug>`).

Carried from earlier and still true: no auth on any page; the `AppSidebar.tsx:124` hydration bug; the
Inbox Hot/Warm tier filters return zero rows; the theme panel nulls `custom_system_prompt`;
`ROOT_DOMAIN`/`APP_BASE_URL` and wildcard DNS are unconfigured; `rr_sync_runs` has no retention SQL
applied.

## How to verify things here

`07-verification.md` has the harness pattern. Three things this recent work added to it:

**Browser verification catches what tests cannot.** The Slack health panel passed tests, types and
lint, and then had five real bugs visible on screen: invented CSS variables painting white-on-white,
a panel ordered above the client summary, a preview row tinted as a delivery, a raw column value
printed as a status, and a diagnosis asserted from no data. Open the page.

**Rendering output catches what tests cannot, either.** The runway-warning-as-heading bug
(`09-morning-brief.md`) was invisible to the whole suite and obvious the moment a realistic brief was
printed with spaces made visible:

```js
console.log(briefWithFooter(body, "America/New_York", new Date(day)).replace(/ /g, "\u00b7"));
```

**`destination: "preview"` is a safe production probe.** `POST /api/slack/brief` with it writes
nothing to Slack, so the deployed behaviour can be measured rather than argued about from a
screenshot. And check `git log -1 --format=%ci` against the clock before believing a change did not
deploy.

**The real CSS tokens are** `--panel`, `--panel-2`, `--border`, `--border-soft`, `--text`, `--muted`,
`--muted-2`, `--accent`, `--green`, `--coral`, `--amber`, `--admin-panel`, `--bg`, `--font`. There is
**no `--rr-*` namespace**; inventing one silently applies every fallback and the result is invisible
text. `color-mix(in srgb, var(--x) N%, var(--panel-2))` is the established tint pattern.

## Standing constraints worth restating

Beyond `05-conventions-and-gotchas.md`:

- **No new runtime dependencies.** `next`, `react`, `react-dom`, `@vercel/speed-insights`,
  `@vercel/analytics`. Raw `fetch` only.
- **Data visualisations are CSS divs, never SVG.**
- **The stylesheet cascade ends at `app/integrity-refinements.css`.** Append there rather than editing
  shared files, so a change made for one card cannot resize a hub of twelve.
- **`shared/*.mjs` is plain ESM, imported with the `.mjs` extension.**
- **Push without asking.** `main` is the release.
- **Paste SQL inline in chat.** Never point at a migration file path.
- **Keep explanatory prose out of the UI.** Titles, counts, clickable examples. No blurbs.
- **Desktop must not change** when mobile is being worked on.
- **PDF is `window.print()` only.**
- **Every new source file carries the watermark banner** — `npm run watermark`.
- **Brain writes are a branch and a PR**, never a direct commit.
- The MCP tab stays labelled "MCP".

## Traps that cost time recently

- **Bash `cwd` resets** to the launch directory after every command, so a scratch script in `/tmp`
  needs **absolute** import paths or it fails with `ERR_MODULE_NOT_FOUND` against `/private/tmp/app/…`.
- **`/api/analytics/client` takes `?client=`**, not `?workspace=`.
- **Explore/Agent subagents fail with "Prompt is too long"** in this repo. Use `Grep` and `Read`.
- **PostgREST fails a whole read over one unknown column**, so an additive column needs a two-select
  fallback and a `delete legacyRecord.<column>` in the write fallback.
- **The heartbeat page is `/health`**, not `/heartbeat`, though the docs call the feature heartbeat.

## History worth keeping

From the `17211f6` cleanup, because the numbers still get questioned: of its 9,387 deletions, 8,310
were `package-lock.json`, 326 an unused starter stylesheet, and 751 across 22 dead files. Live source
was untouched. What made it safe: inventory every candidate, grep the whole repo, and **delete only
what is referenced solely by other dead files.** That method caught two near-mistakes — Tailwind looks
like starter cruft but is live in `globals.css` and 8 components, and `worker/job-queue.ts` had
*passing tests* despite being an unwired stub.

Two lessons from it that still apply:

**A test that has never executed is not a test.** `npm test` had only ever run a starter file; fixing
the script surfaced a real stale assertion immediately.

**If a verification result looks catastrophic, suspect the verification first.** Next 16 serves CSS
from `/_next/static/chunks/*.css`, not `/_next/static/css/`, and grepping the old path reported zero
stylesheets, which looked like a broken front end and was a broken check.
