# Reply Radar — read this first

Internal LinkedIn reply-management platform for **QC Growth**, a GTM agency running outbound for
multiple clients through HeyReach. Replies from every client land in one inbox; Claude classifies
sentiment and follow-up urgency, scores the lead against the client's ICP, and drafts a response
before anyone opens the thread.

**Next.js 16 App Router + React 19 on Vercel · Supabase over the PostgREST REST API only · Anthropic
`claude-haiku-4-5-20251001` · a separate always-on Render worker (`worker/render-worker.mjs`).**

## Full context lives in `context/`

Read it rather than re-deriving things. `context/README.md` is the index.

| | |
|---|---|
| [`context/01-system-overview.md`](context/01-system-overview.md) | Product, hosting, architecture, pages, what's out of scope. |
| [`context/02-backend-rundown.md`](context/02-backend-rundown.md) | Every route, PostgREST conventions, the worker cycle, deletion, the purge, time-zone maths. |
| [`context/03-data-model.md`](context/03-data-model.md) | Tables, the JSON where AI state lives, and the schema drift. |
| [`context/04-issues-and-fixes.md`](context/04-issues-and-fixes.md) | **Every bug and its root cause. Read before touching deletion, dedupe, direction or the origin classifier.** |
| [`context/05-conventions-and-gotchas.md`](context/05-conventions-and-gotchas.md) | House rules, lint baseline, repo traps. |
| [`context/06-product-decisions.md`](context/06-product-decisions.md) | Settled decisions, including reversed ones. Do not relitigate. |
| [`context/07-verification.md`](context/07-verification.md) | How to prove a change works with no local credentials. |
| [`context/08-session-handoff.md`](context/08-session-handoff.md) | **Current state: recent commits, what's verified, what's still open.** Start here if picking up cold. |
| [`context/00-original-handoff.md`](context/00-original-handoff.md) | The original handoff, verbatim. Historical where it conflicts with the above. |

## The eight things that catch everyone out

1. **`app/page.tsx` is the inbox.** The home page is `app/components/DashboardHome.tsx`.
2. **`supabase/schema.sql` has drifted from production.** Read the real columns in Supabase before
   writing a query. `rr_leads` uses `role` / `linkedin_id` / `linkedin_profile_url`, not the file's
   `title` / `profile_url`. `rr_scores` may not exist at all.
3. **"A lead" is a person, not a row.** `rr_leads` is keyed per client; the drawer merges every row
   sharing `linkedin_profile_url`. Deletion must be person-scoped — see `app/lib/lead-deletion.ts`.
4. **Exact totals come from `Prefer: count=exact` + `Range: 0-0`** and the `Content-Range` header
   (`app/lib/rest-count.ts`). Never report a page length as a total.
5. **`DELETE` needs `Prefer: return=representation`.** Otherwise a delete that did nothing is
   indistinguishable from one that worked. This caused a real bug.
6. **The worker cannot import TypeScript.** It's plain ESM. Shared logic goes in `shared/*.mjs`; AI
   work goes through `/api/ai/*` routes the worker calls over HTTP. Never keep a second copy.
7. **There is no local `.env`**, so no local production data. Anything needing live data must be a
   button the owner clicks. Verify changes with the harness pattern in `context/07-verification.md`.
8. **Lint baseline is exactly 6 errors.** Any seventh is yours. Don't fix the existing 6 as drive-by
   work.

## Rules

- Supabase is the source of truth; React state is a cache.
- Every mutation needs a real API request, error handling, and a visible success/error state.
- Never `alert()`/`prompt()` for data entry. `window.confirm` is acceptable only for a destructive
  confirmation, and it must spell out the exact scope.
- Never hardcode demo names, counts or dates.
- Keep global appearance separate from per-client branding.
- Route on stable IDs and slugs, never display names.
- Comments explain **why**, and name the failure they prevent.
- Excluded data gets no UI. The owner rejected a review queue for cold-inbound leads outright — see
  `context/06-product-decisions.md`.

## Out of scope, permanently

Authentication of any kind. Webhook secret verification. Encryption of HeyReach keys at rest.

## Before committing

```bash
npm run typecheck     # clean
npm run lint          # exactly 6 errors
npm test              # 10 passing
npm run build         # confirm any new route appears in the route list
```

`main` deploys to Vercel and Render automatically. **A push is a release.**
