# 5. Conventions and gotchas

## Non-negotiables

These come from the owner and from things that broke. Treat them as constraints, not preferences.

1. **Supabase is the source of truth.** React state is a cache and a view. Never let the UI be the
   only place a fact exists.
2. **Every create/update/delete needs a real API request**, error handling, a reload or optimistic
   rollback, and a **visible** success or error state. A silent mutation is a bug even when it works.
3. **Never `alert()`, `confirm()` or `prompt()` for data entry.** `window.confirm` for a destructive
   confirmation is the one accepted exception, and it must spell out the scope ("removes 4
   conversations and 2 lead records across 2 clients, plus every message. It cannot be undone.").
4. **No secrets in client bundles.** The service-role key is server-side, always. Anything holding it
   is a route handler.
5. **No placeholder names, counts or dates.** Not in production, not "temporarily".
6. **Route on stable IDs and slugs**, never display names.
7. **Global appearance stays separate from per-client branding.** A client's accent must not overwrite
   the admin/global accent.
8. **Timestamps come from the server or browser clock.** Never hardcode a date.
9. **`npm run build` before every commit.** `main` deploys to Vercel and Render automatically, so a
   push is a release.

## Where things live

| Need | Put it in |
|---|---|
| Server logic for one route | that route's `route.ts` |
| Server logic shared by several routes | `app/lib/*.ts` |
| Logic the **worker** also needs | `shared/*.mjs`, JavaScript with JSDoc types |
| Anything Anthropic-related | a route under `app/api/ai/`, so the worker gets it for free |

**Never duplicate logic across the `.mjs`/TypeScript boundary.** The worker runs as plain ESM and
cannot import TypeScript. Either put it in `shared/`, or expose it as a route the worker calls. A
second copy diverged once and corrupted message direction — see `04-issues-and-fixes.md`.

## The home page is not `app/page.tsx`

- `app/page.tsx` — **the inbox**, ~2,900 lines.
- `app/inbox/page.tsx` — a re-export of `InboxPage`.
- `app/components/DashboardHome.tsx` — **the home page**.

## CSS

Five stylesheets are live: `globals.css`, `dashboard.css`, `inbox-analytics.css`,
`feature-overrides.css`, `integrity-refinements.css`, `reply-radar-overrides.css`. Tailwind is
imported in `globals.css` and utility classes are used alongside the hand-written CSS.

**Order sections by named class, never by `nth-of-type`.** Positional ordering already caused a page
to silently reshuffle when a section was inserted.

Numbers that change should use `font-variant-numeric: tabular-nums` so they don't jitter.

## Accessibility patterns already settled

- Autofocus: `useRef` + `useEffect` → `.focus()`. Not the `autoFocus` prop (`jsx-a11y/no-autofocus`).
- A clickable card that contains its own buttons is `<div role="button">`, not `<button>`, so the
  nested button stays valid HTML.

## Lint baseline: exactly 6 errors

Do not "fix" these as drive-by work; do not add a seventh.

| Location | Error |
|---|---|
| `app/api/inbox/route.ts:78` | `'latestBody' is assigned a value but never used` |
| `app/page.tsx:900–902` | three × `react-hooks/use-memo` — dependency list is not simple expressions |
| `app/page.tsx:1235` | `jsx-a11y/click-events-have-key-events` |
| `app/page.tsx:1235` | `jsx-a11y/no-static-element-interactions` |

Warnings (mostly `@next/next/no-img-element`) are expected and not tracked.

## Commands

```bash
npm run dev
npm run typecheck     # tsc --noEmit
npm run lint          # expect exactly 6 errors
npm test              # node --test tests/*.test.mjs — expect 10 passing
npm run build
npm run worker:start
```

`node --test tests/` does **not** work on Node 24 — it resolves the directory as a module and fails
with `MODULE_NOT_FOUND`. The glob form is required.

## Repo-specific traps

- **`supabase/schema.sql` is stale.** Read the real columns in Supabase. See `03-data-model.md` for
  the known divergences.
- **`heyreach_api_key_ciphertext` is not ciphertext.** Encryption was de-scoped; the name is
  historical.
- **The `[secret]` segment on the webhook route is not validated.** De-scoped.
- **There is no local `.env`.** No local production data. Anything needing live data must be a button
  the owner clicks — which is why the purge is a two-phase UI action and not a script.
- **`AI_CANDIDATE_LIMIT` (200) and the 7-day enrichment backoff are constants**, not environment
  variables, despite older notes describing them as env vars.
- **Explore/Agent subagents fail with "Prompt is too long"** here. Use `Grep` and `Read` directly.
- **Kill the port before re-running a harness:** `lsof -ti tcp:<port> | xargs -r kill -9`. `SIGKILL`
  on `npm start` can leave the child listening.

## Code style in this repo

Comments explain **why**, not what, and they name the failure they prevent. This is deliberate and
worth continuing — most of the non-obvious code here exists because of a specific incident, and the
comment is the only place that context survives. For example:

```ts
// `tolerateMissingTable` covers `rr_scores`, which the checked-in schema declares but which may not
// exist in a given database. A table that isn't there holds no rows to orphan, so a 404 is a
// legitimate no-op — any other failure still throws.
```

```ts
// Ordered by id because it is unique: paging by last_message_at would revisit or skip rows
// wherever two conversations share a timestamp.
```

Don't add comments restating the code. Do add one whenever a reader would reasonably try to
"simplify" something load-bearing.
