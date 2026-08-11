# Reply Radar — Project Handoff

## What this project is

Reply Radar is an internal HeyReach follow-up intelligence dashboard for QC Growth. It is a Next.js application hosted on Vercel, backed by Supabase, with a long-running Render worker that polls/syncs data and records heartbeats.

Repository: `https://github.com/kirilQC/reply-radar`

Primary local workspace: `/Users/kiril/Documents/Codex/2026-08-06/are`

## Hosting and infrastructure

- Frontend/API: Vercel, deployed from GitHub `main`.
- Database: existing Supabase project. Reply Radar tables use the `rr_` prefix so they do not collide with existing tables.
- Worker: Render Background Worker, service name `reply-radar`, running `npm run worker:start` / `node worker/render-worker.mjs`.
- AI provider: Anthropic, configured through environment variables and per-client AI settings.
- HeyReach: each client/workspace has its own API key and webhook URL. Keys are entered in the app and stored in Supabase; they must not be put into Render as one global key.

## Environment variables

Vercel and Render should have the server-side values below (never expose service-role keys in browser code):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ANTHROPIC_API_KEY`
- `POLL_INTERVAL_SECONDS` (usually `120`)
- `WORKER_SERVICE_URL` (optional, used for health visibility)
- `APP_BASE_URL` (Render only — the public URL of the Vercel deployment, e.g. `https://replyradar.example.com`). The worker calls the app's AI routes over HTTP so new replies are analysed, ICP-scored and follow-up-scored in the background; without it the AI sweep logs that it is skipped and the rest of the worker carries on.
- `AI_BATCH_SIZE` (Render only, optional, default `10`) — conversations put through the AI pipeline per cycle. Each one costs up to three Anthropic calls plus, for a lead seen for the first time, one AI Ark lookup.
- `AI_ARK_API_KEY` (Vercel) — the worker reaches AI Ark through the app's `/api/ai/enrich` route, so the key belongs on Vercel, not Render.

The Supabase service-role key must remain server-side. The public Supabase anon key may be used by a browser client only if RLS is designed correctly; this app currently favors server API routes.

## Database model

Reply Radar currently uses these Supabase tables:

- `rr_global_config`
- `rr_workspaces`
- `rr_profiles`
- `rr_profile_workspaces`
- `rr_profile_preferences`
- `rr_conversations`
- `rr_messages`
- `rr_leads`
- `rr_scores`
- `rr_graphs`
- `rr_documents`
- `rr_webhook_events`
- `rr_sync_runs`
- `rr_audit_log`
- `rr_device_preferences`

Do not drop or rename the user's unrelated existing tables. Before changing schema, inspect the actual columns in the Supabase project. Several past bugs came from code assuming columns that were not present (for example `avatar_url` and `rr_sync_runs.run_type`).

## Main application behavior

- `/` is the dashboard/landing page.
- `/inbox` is the general inbox when no client/profile is selected.
- `/inbox?workspace=<slug>` (or the project's current equivalent route state) should show only that client's conversations.
- `/inbox?profile=<slug>` should show the assigned clients for that profile.
- `/profiles` lists teammate profiles; clicking a profile opens its assigned-client inbox and profile settings are editable.
- `/analytics` shows performance analytics.
- `/health` is the Heartbeat/system health page.
- `/database` is a placeholder database tab.
- `/admin` is the configuration console. It should open to Global config.
- Admin also contains Client directory, Heartbeat, and Audit log.

## Product requirements already established

### Dashboard

- Show QC Growth centered at the top.
- Show Performance overview, Profiles, and Client workspaces.
- Profiles should appear above client workspaces.
- Four client cards should fit on a horizontal row when space allows.
- Do not use placeholder client/profile names or fake counts in production. Data must come from Supabase.
- Client cards must route to that client's inbox, not the general inbox.

### Inbox

- General inbox title should be `General inbox`.
- Client inbox title should be the client name and logo.
- Profile inbox title should be the profile name and show assigned client chips/logos.
- Do not show the old `Priority inbox` wording or hardcoded `12` / `Hot 4` values.
- Filter and sort must be functional.
- Layout customization is per profile; for the general inbox it can fall back to device/IP preferences.
- Appearance customization (theme, accent, font, zoom, background) should apply globally across the site and persist per profile/device.
- Remove the question-mark button. Keep responsive appearance/layout controls where requested.

### Profiles

- Profile fields: full name, profile photo, assigned clients, appearance/layout preferences.
- Profile saves must persist to Supabase and immediately update dashboard, sidebar, and inbox.
- Profile photo must render on profile cards and all profile surfaces.
- Profile deletion requires confirmation; workspace deletion requires password `QueenCity@2026` (this is an internal app requirement, but do not treat it as production-grade authentication).

### Client configuration

- Admin opens to Global config.
- Client directory should be a directory/search/list, not a row of 20–30 client cards that does not scale.
- Clicking a client opens a dedicated client page, not merely a dropdown.
- Per-client fields include: name, slug, website, logo/photo, HeyReach API key, full webhook URL, timezone (default `America/New_York` / Eastern Time), client brief, AI model, temperature, system prompt, scoring rules, theme/accent, documents.
- Save changes must persist and rehydrate after refresh.
- Client-specific accent must not overwrite the global/admin appearance accent.
- Remove obsolete Rotate key and Backfill buttons unless a real backend action is implemented.
- View event log must route to the client's event log.
- Document upload should open the computer file picker and persist the file to Supabase Storage.
- Add/remove client must update Supabase and all live views (sidebar, dashboard, general inbox, profile assignment choices).
- Date created should appear at the bottom of the client config page, not in the directory card.

### Heartbeat

Heartbeat should have:

1. Basic view: plain-language status for Supabase, Anthropic, Render worker, and each client. Explain what each check means and show success/attention/missing.
2. Advanced view: raw timestamps, ages in seconds, HTTP/API status, worker cycle metadata, error text, row counts, sync run details, webhook/poll timestamps, and raw diagnostic JSON where useful.

Worker heartbeat is written by Render to `rr_sync_runs`. Client heartbeat checks key presence, last webhook received, and last successful poll. Never call something healthy merely because a row exists; use explicit timestamps and freshness thresholds.

## Current code areas

- `app/components/DashboardHome.tsx` — dashboard and profile cards.
- `app/health/page.tsx` — Basic/Advanced heartbeat UI.
- `app/api/heartbeat/route.ts` — heartbeat API; verify selected columns against actual Supabase schema.
- `app/api/admin/profiles/route.ts` — profile list/create API.
- `app/api/webhooks/heyreach/[workspaceId]/route.ts` — HeyReach webhook receiver.
- `app/reply-radar-overrides.css` — global visual overrides, accent variables, layout styles.
- `worker/render-worker.mjs` — Render polling worker.

## Known recent issues to verify first

1. Profile photo may save to `rr_profiles` but not render on dashboard; confirm the API returns `avatar_url` and the dashboard maps it to `photo`.
2. Heartbeat API/UI was recently expanded; make sure CSS exists for `.health-actions`, `.segmented-control`, `.heartbeat-*`, `.diagnostic-details`, and related classes.
3. HeyReach's Test Webhook currently returns an HTML 404 from `https://replyradar.app/api/webhooks/heyreach/cotool`. The compatibility route must support `GET`, `HEAD`, and `POST`. If the Vercel deployment URL works but the custom domain returns the marketing-site 404, `replyradar.app` is pointed at a different/stale Vercel project and needs to be reassigned.
4. Render worker has previously failed from schema mismatch in `rr_sync_runs` (`run_type`, then `run_type` NOT NULL). Inspect the real table schema and make the insert payload match it. Avoid repeated migrations that assume columns.
5. Render worker has also shown `Unexpected end of JSON input`; all worker fetches must check response status/content-type before calling `response.json()` and log response text on failure.
6. Sidebar previously flickered from empty to populated. Prefer a stable loading skeleton or cached last-known client list rather than rendering an empty list before the fetch completes.
7. All hardcoded demo names/counts must stay removed. Search the repository for demo values before release.

## Recommended immediate debugging sequence

1. Run `rg -n "Pylon|Vectorly|Northstar|Priority queue|Hot 4|12 conversations|avatar_url|run_type" app worker` and remove any remaining demo constants or schema assumptions.
2. Inspect Supabase columns for `rr_profiles`, `rr_workspaces`, and `rr_sync_runs`.
3. Test the webhook on both the current Vercel deployment domain and `replyradar.app`:
   - `GET /api/webhooks/heyreach/<workspace-slug>` should return JSON `{ ok: true, webhook: "ready" }`.
   - `POST` should accept a HeyReach payload and return JSON 200.
4. Verify Render worker writes one successful `rr_sync_runs` row per cycle.
5. Verify a profile photo, client logo, client name, API key, model, timezone, and website survive a hard refresh.
6. Run `npm run build` before committing.
7. Commit and push to `main`; Vercel and Render deploy from that branch.

## Important implementation principles

- Supabase is the source of truth; React state is only a cache/view.
- Every create/update/delete needs a real API request, error handling, optimistic rollback or reload, and a visible success/error state.
- Never use `alert()`/browser prompts for normal data entry.
- Never put secret keys in client-side bundles or Git.
- Keep global appearance preferences separate from per-client branding.
- Use stable IDs/slugs for routing, not display names.
- Use current timestamps from the server/browser clock; do not hardcode dates such as August 6/7, 2026.

