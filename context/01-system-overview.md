# 1. System overview

## What the product is

Reply Radar is an internal tool for **QC Growth**, a GTM agency running LinkedIn outbound on behalf
of multiple clients through **HeyReach**. Each client has their own HeyReach account, their own
sending profiles, their own campaigns, and their own ICP.

The problem it solves: replies arrive across many clients and many sender accounts, most of them are
noise, and the person handling them has no way to tell which three of today's forty replies are
worth a careful answer. Reply Radar puts them all in one inbox, scores them, and pre-writes a reply
in the client's voice.

## Who reads it

Agency operators, not engineers, and not the clients. That has consequences:

- Numbers on screen must be **exact and honest**. "50 loaded" describing a fetch instead of the data
  was a real complaint. If a count is filtered, the label says so.
- Weeks start on **Monday**, because this is read as a working-week report.
- "Today" means the **reader's** today, from their saved time zone, not the server's.
- Excluded data should be **gone**, not surfaced for review. See `06-product-decisions.md`.

## Hosting

| Piece | Where | Notes |
|---|---|---|
| App + API | **Vercel**, deployed from GitHub `main` | `github.com/kirilQC/reply-radar` |
| Database | **Supabase** (an existing project shared with unrelated tables) | All Reply Radar tables are prefixed `rr_`. Never touch un-prefixed tables. |
| Background worker | **Render** background worker, service `reply-radar` | `npm run worker:start` → `node worker/render-worker.mjs` |
| AI | **Anthropic**, `claude-haiku-4-5-20251001` by default | Per-client model override lives in `rr_workspaces.anthropic_model`. |
| Outbound platform | **HeyReach** | One API key **per client**, entered in the app, stored in Supabase. |
| Enrichment | **AI Ark** | Reached through `/api/ai/enrich`, so its key lives on Vercel. |

`main` deploys to both Vercel and Render automatically. Push means ship.

## Shape of the system

```
  HeyReach reply
       │
       ├──── webhook ────────────► /api/webhooks/heyreach/[workspaceId]
       │                                    │
       │                                    └── writes rr_conversations / rr_messages / rr_leads
       │
       └──── poll (every 2 min) ──► Render worker
                                            │
                                            ├── HeyReach connection check per client
                                            ├── conversation refresh (every 24h)
                                            └── AI sweep, every cycle
                                                     │
                                                     └── HTTP POST to the Vercel app:
                                                         /api/ai/enrich
                                                         /api/conversations/sentiment
                                                         /api/ai/draft
                                                         /api/ai/icp-score
                                                         /api/ai/follow-up-score
                                                                │
                                                                └── Anthropic, then
                                                                    write results back into
                                                                    raw_data.reply_radar
```

Reads and writes both happen over PostgREST. The browser never talks to Supabase; every read goes
through a route handler in `app/api/`.

## The three structural decisions

### 1. PostgREST only, no Supabase client library

Every database call is a `fetch` to `${SUPABASE_URL}/rest/v1/...` with `apikey` and
`Authorization: Bearer` headers set to the service-role key. This is why the codebase has helpers
like `app/lib/rest-count.ts` and `app/lib/chunk-query.ts` instead of a query builder.

Two PostgREST behaviours the codebase leans on heavily:

- `Prefer: count=exact` with `Range: 0-0` returns an empty page plus the true total in the
  `Content-Range` response header. **This is how every exact total is obtained without fetching a
  single row.** See `app/lib/rest-count.ts`.
- `Prefer: return=representation` on a `DELETE` makes PostgREST return the deleted rows. Without it
  a delete that matched nothing is indistinguishable from one that matched everything. This caused a
  real bug — see `04-issues-and-fixes.md`.

### 2. The worker calls the app, not Anthropic

`worker/render-worker.mjs` is plain ESM run directly by Node. It **cannot import the TypeScript
under `app/lib/`**. Rather than duplicate prompt construction, model selection and result-writing on
the worker side, the worker POSTs to the app's own `/api/ai/*` routes.

Consequences worth internalising:

- A prompt or default changed in a route handler immediately applies to both the browser and the
  worker. There is no second copy to keep in sync.
- `APP_BASE_URL` on Render is what makes background analysis work at all. Without it, the sweep logs
  that it is skipped and the rest of the worker carries on normally.
- The worker needs no Anthropic key and no AI Ark key.

### 3. `shared/*.mjs` for logic both sides genuinely need

Where the worker needs the same *judgement* as the app and an HTTP hop makes no sense, the logic
lives in `shared/` as JavaScript with JSDoc types (`allowJs: true` in tsconfig):

- `shared/message-identity.mjs` — who sent a message, and its stable identity.
- `shared/conversation-origin.mjs` — did we open this conversation, or did the lead?

This exists because of a specific outage: while the worker kept its own copy of direction logic, the
two sides disagreed about who sent a message. The same message got stored twice under opposite
directions, and QC Growth's own outreach appeared in the inbox as if the lead had written it.

## Pages

| Route | File | Purpose |
|---|---|---|
| `/` | `app/components/DashboardHome.tsx` (via `app/page.tsx`'s sibling) | Home: headline stats, teammate profiles, client workspaces. |
| `/inbox` | `app/page.tsx` (~2.9k lines), re-exported by `app/inbox/page.tsx` | The inbox. `?workspace=<slug>` scopes to a client, `?profile=<slug>` to a teammate's assigned clients. |
| `/database` | `app/database/page.tsx` | Live lead database with search, exact totals, deletion, purge. |
| `/analytics` | `app/analytics/page.tsx` | Per-client performance. `?client=<slug>`, or a subdomain via middleware. |
| `/profiles` | `app/profiles/page.tsx` | Teammate profiles and their assigned clients. |
| `/admin` | `app/admin/page.tsx` | Global config, client directory, per-client configuration, audit log. |
| `/health` | `app/health/page.tsx` | Heartbeat, basic and advanced views. |
| `/calendar`, `/reports` | | Secondary surfaces. |

> **The home page is `app/components/DashboardHome.tsx`, not `app/page.tsx`.** `app/page.tsx` is the
> inbox. This trips people up constantly.

## Subdomains

`middleware.ts` rewrites `acme.<ROOT_DOMAIN>` → `/analytics?client=acme`, so each client can have
their own reporting URL. It is a no-op until `ROOT_DOMAIN` is set, and it needs wildcard DNS plus the
wildcard domain added in Vercel. **None of that is configured yet.** The equivalent
`/analytics?client=<slug>` path works today and is unaffected.

## Explicitly out of scope

Permanently de-scoped by the owner, do not build these:

- **Authentication of any kind.** No login, no sessions, no user identity.
- **Webhook secret verification.** The `[secret]` path segment exists for HeyReach URL compatibility
  only; it is not validated.
- **Encryption of HeyReach API keys at rest.** The column is named `heyreach_api_key_ciphertext` for
  historical reasons; it holds the key.
