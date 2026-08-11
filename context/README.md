# Reply Radar — project context

Everything a fresh session needs in order to work on this codebase without being re-briefed.

Written to be read in order, but each file stands alone. If you only read one thing, read
[`04-issues-and-fixes.md`](04-issues-and-fixes.md) — it is where the expensive lessons are.

| File | What's in it |
|---|---|
| [`00-original-handoff.md`](00-original-handoff.md) | The original project handoff, kept verbatim. Some of it is now historical; where it conflicts with the files below, the files below are newer. |
| [`01-system-overview.md`](01-system-overview.md) | What the product is, who reads it, hosting, and the shape of the whole system. |
| [`02-backend-rundown.md`](02-backend-rundown.md) | How the backend actually works: PostgREST conventions, every route, the worker's cycle, the AI pipeline. |
| [`03-data-model.md`](03-data-model.md) | Tables, the JSON blobs where AI state lives, and the schema drift you must not trust. |
| [`04-issues-and-fixes.md`](04-issues-and-fixes.md) | Every real bug this project has hit, the root cause, and the fix. Read before changing deletion, dedupe, direction or scoring. |
| [`05-conventions-and-gotchas.md`](05-conventions-and-gotchas.md) | House rules, the lint baseline, patterns to copy, and traps in this specific repo. |
| [`06-product-decisions.md`](06-product-decisions.md) | Decisions the owner has already made, including ones that were reversed. Do not relitigate these. |
| [`07-verification.md`](07-verification.md) | How to prove a change works when there are no local credentials. The harness pattern. |

## The thirty-second version

Reply Radar is QC Growth's internal LinkedIn reply manager. HeyReach conversations for every client
land in one inbox; Claude classifies each reply's sentiment and follow-up urgency, scores the lead
against the client's ICP, and drafts a response — all before anyone opens the thread.

Next.js 16 on Vercel. Supabase reached **only** over the PostgREST REST API. A separate always-on
Render worker (`worker/render-worker.mjs`) polls HeyReach and drives the AI pipeline by calling the
app's own `/api/ai/*` routes over HTTP.

There is **no authentication** and it is intentionally out of scope.

There is **no local `.env`**, so no local production data. Anything needing live data has to be a
button in the app that the owner clicks.
