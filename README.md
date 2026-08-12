<div align="center">

<img src="public/qc-growth-logo.png" alt="QC Growth" width="96" />

# Reply Radar

**One LinkedIn inbox across every client, scored and drafted by Claude.**

Internal reply-management platform for QC Growth. Pulls every HeyReach conversation for every
client into a single inbox, works out which replies actually deserve attention, and has a draft
waiting before anyone opens the thread.

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-087EA4?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Supabase](https://img.shields.io/badge/Supabase-PostgREST-3FCF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![Claude](https://img.shields.io/badge/Claude-Haiku_4.5-D97757?logo=anthropic&logoColor=white)](https://www.anthropic.com)
[![Vercel](https://img.shields.io/badge/Vercel-app-000000?logo=vercel&logoColor=white)](https://vercel.com)
[![Render](https://img.shields.io/badge/Render-worker-46E3B7?logo=render&logoColor=white)](https://render.com)

</div>

---

## What it does

| | |
|---|---|
| **Unified inbox** | Every client's HeyReach conversations in one place, or filtered to a single client or teammate. Conversations the lead started cold are dropped — we only manage replies to our own outreach. |
| **Reply scoring** | Each inbound message is classified for sentiment and follow-up urgency, so a real buying signal doesn't sit behind forty "thanks, not right now"s. |
| **ICP scoring** | Each lead is scored against the client's ideal-customer definition, with the client brief threaded into the prompt. |
| **Drafted replies** | A suggested reply is cached against every message before anyone opens it, written in the client's voice from their messaging doc and system prompt. |
| **Lead enrichment** | Company and role data filled in from AI Ark, with company logos matched where available. |
| **Live lead database** | Every lead across every client, searchable, with exact totals and verified complete deletion. |
| **Per-client analytics** | Reply and performance reporting, optionally on a client subdomain. |
| **Heartbeat** | Plain-language and raw-diagnostic health for Supabase, Anthropic, the Render worker and each client. |

## Architecture

```
  HeyReach          ┌──────────────────────────────────┐
  webhooks ───────► │  Vercel — Next.js 16 app         │
                    │  UI + /api/* route handlers      │
                    └──────┬────────────────────┬──────┘
                           │                    │
                    PostgREST REST          Anthropic
                           │                    │
                    ┌──────▼────────┐   ┌───────▼───────┐
                    │   Supabase    │   │    Claude     │
                    │  rr_* tables  │   │   Haiku 4.5   │
                    └──────▲────────┘   └───────────────┘
                           │
                    ┌──────┴───────────────────────────┐
                    │  Render — background worker      │
                    │  worker/render-worker.mjs        │
                    │  polls HeyReach, then calls the  │
                    │  app's /api/ai/* routes so every │
                    │  new reply gets analysed         │
                    └──────────────────────────────────┘
```

Three deliberate choices worth knowing before changing anything:

- **Supabase is reached only over the PostgREST REST API.** No Supabase client library. Exact
  totals come from `Prefer: count=exact` + `Range: 0-0` and reading `Content-Range`; deletes send
  `Prefer: return=representation` so the number of rows actually removed is known, not assumed.
- **The worker calls the app, not Anthropic.** It runs as plain ESM and cannot import the
  TypeScript under `app/lib/`, so all AI work goes through `/api/ai/*`. One implementation serves
  both the browser and the worker, and prompt defaults can never drift between them.
- **Logic both sides need lives in `shared/*.mjs`** as JavaScript with JSDoc types. While the worker
  kept its own copy of message-direction logic the two disagreed about who sent a message, which
  stored the same message twice and made our own outreach appear as if the lead had written it.

## Layout

```
app/
  page.tsx                  the inbox
  components/
    DashboardHome.tsx       the home page — stats, profiles, client workspaces
  admin/ analytics/ calendar/ database/ health/ profiles/ reports/
  api/                      every server route (see below)
  lib/                      server-side helpers, TypeScript
shared/                     logic shared by the app and the worker, plain ESM
worker/render-worker.mjs    the Render background worker
supabase/                   schema and migrations (see the warning below)
tests/                      node:test unit tests
context/                    full project context for a fresh session
```

<details>
<summary><strong>API routes</strong></summary>

| Route | Purpose |
|---|---|
| `POST /api/webhooks/heyreach/[workspaceId]` | HeyReach reply webhook. `GET`/`HEAD` answer HeyReach's test ping. |
| `GET /api/inbox` | Conversation list, deduplicated, cold-inbound and orphaned threads excluded. |
| `POST /api/conversations/refresh` | Pull a thread's full history from HeyReach. |
| `POST /api/conversations/sentiment` | Classify an inbound message. |
| `POST /api/ai/draft` | Draft a reply in the client's voice. |
| `POST /api/ai/icp-score`, `/api/ai/follow-up-score` | Score a lead and a thread. |
| `POST /api/ai/enrich` | AI Ark lookup for a lead. |
| `/api/ai/templates`, `/api/ai/config`, `/api/ai/audit` | Shared prompt library, per-client AI settings, prompt audit trail. |
| `GET /api/analytics` | Per-client performance reporting (calls HeyReach). |
| `GET /api/analytics/summary` | Home-page headline totals — exact counts only. |
| `GET /api/database/leads`, `DELETE /api/database/leads/[leadId]` | Lead database, with verified complete deletion. |
| `POST /api/database/purge` | Preview, then remove cold-inbound and orphaned conversations. |
| `GET /api/heartbeat`, `GET /api/health` | System health. |
| `/api/admin/workspaces`, `/profiles`, `/audit`, `/heyreach/check` | Client and teammate administration. |
| `/api/preferences` | Per-profile and per-device appearance and layout. |

</details>

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

```bash
npm run typecheck
npm run lint
npm test
npm run build        # run this before every commit
npm run worker:start # the Render worker, locally
```

Requires Node `>=22.13.0`.

## Environment

Server-side only. The Supabase service-role key must never reach a browser bundle.

**Both Vercel and Render**

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only, always. |

**Vercel**

| Variable | Notes |
|---|---|
| `ANTHROPIC_API_KEY` | |
| `AI_ARK_API_KEY` | The worker enriches through `/api/ai/enrich`, so the key belongs here, not on Render. |
| `ROOT_DOMAIN` | Optional. Enables `acme.example.com` → `/analytics?client=acme`. Needs wildcard DNS plus the wildcard domain added in Vercel. Until then `/analytics?client=<slug>` works unchanged. |

**Render**

| Variable | Default | Notes |
|---|---|---|
| `APP_BASE_URL` | — | Public URL of the Vercel deployment; a bare hostname is accepted. Without it the AI sweep logs that it is skipped and the rest of the worker carries on. |
| `POLL_INTERVAL_SECONDS` | `120` | Floor of 30. |
| `AI_BATCH_SIZE` | `10` | Conversations through the AI pipeline per client per cycle. |
| `AI_CONCURRENCY` | `4` | Conversations analysed at once. |
| `AI_CYCLE_BUDGET_SECONDS` | `600` | When the budget runs out the worker remembers which client it stopped at and resumes there, so a backlog at one client cannot starve the others. |
| `HEYREACH_API_BASE` | `https://api.heyreach.io/api/public` | Rarely changed. |
| `WORKER_SERVICE_URL` | — | Optional, for health visibility. |

Two limits are constants in `worker/render-worker.mjs` rather than environment variables: the sweep
considers the newest 200 replies needing work per client, and a lead AI Ark could not match is left
alone for seven days (AI Ark bills five attempts per call, so retrying every cycle spends real money
re-learning the same answer).

HeyReach API keys are **per client**, entered in the app and stored in Supabase. There is no global
HeyReach key and none should be added to Render.

## Data model

Every table is prefixed `rr_` so nothing collides with the rest of the Supabase project:
`rr_workspaces`, `rr_profiles`, `rr_profile_workspaces`, `rr_profile_preferences`,
`rr_conversations`, `rr_messages`, `rr_leads`, `rr_scores`, `rr_graphs`, `rr_documents`,
`rr_webhook_events`, `rr_sync_runs`, `rr_audit_log`, `rr_device_preferences`, `rr_global_config`,
`rr_app_config`, `rr_reports`.

> [!WARNING]
> **`supabase/schema.sql` has drifted from production.** Inspect the real columns in Supabase before
> relying on it. Several past outages came from code assuming a column that was not there. `rr_scores`
> is declared but may not exist in a given database — which is why deletion tolerates a 404 on that
> table and removes children explicitly instead of trusting `on delete cascade`.

> [!IMPORTANT]
> **`rr_global_config` is a single-row settings table** — `id boolean primary key`, one column per
> setting. It has no `key`/`value` columns. Small key/value lists belong in `rr_app_config`
> (`supabase/migrations/20260812_rr_app_config.sql`). Report templates were moved there after every
> save failed with "column rr_global_config.key does not exist"; `app/api/ai/templates/route.ts` and
> `app/api/ai/config/route.ts` still make the same mistake and still silently fail to save.

AI state lives in JSON rather than columns, so adding a signal never needs a migration:

- `rr_messages.raw_data.reply_radar` — `sentiment`, `analyzed_at`, `cached_draft`, `cached_reason`,
  `followup_urgency`, `followup_reason`, `followup_analyzed_at`, plus `sender` / `campaign` /
  `conversation` metadata.
- `rr_leads.raw_data.reply_radar` — `icp_score`, `icp_reason`, `icp_scored_at`, `ai_ark`,
  `enrichment_status`, `history_status`, `attributions`, `rollup`.

## Working on this

Read [`context/`](context/) first. It carries the full backend rundown, every issue this project has
hit and how it was fixed, and the conventions that are not obvious from the code.

The rules that matter most:

- Supabase is the source of truth; React state is a cache.
- Every mutation needs a real API request, error handling, and a visible success or error state.
- Never `alert()` or use browser prompts for data entry.
- Never hardcode demo names, counts or dates.
- Keep global appearance preferences separate from per-client branding.
- Route on stable IDs and slugs, never display names.
- Run `npm run build` before committing. `main` deploys to Vercel and Render automatically.

---

<div align="center">
<sub>Internal tool for QC Growth. Not open for public use.</sub>
</div>
