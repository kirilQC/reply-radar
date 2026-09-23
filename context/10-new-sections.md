# Reply Radar — new sections & the auth gate

What was built after the morning brief: three new client-scoped sections, a site-wide password, a bigger
assistant, and the audit that hardened all of it. Each follows the same shape — a Supabase table, pure logic
in `shared/*.mjs` (unit-tested), I/O in `app/lib/*.ts`, routes under `app/api/<section>/`, and a directory →
per-client UI that mirrors the onboarding hub.

## The password gate (this is new — the site used to be open)

- Everything a person can browse is behind one shared password. `middleware.ts` checks a signed session
  cookie on every request; no cookie → `/login` (pages) or 401 (APIs). One login sets a cookie scoped to
  `.<ROOT_DOMAIN>`, so it covers the apex and every client subdomain for 30 days.
- `app/lib/auth.ts` is the crypto: the cookie is an HMAC of a constant keyed by a server secret, never the
  password. Credentials are read **only from env** — `APP_PASSWORD` (shared) and `APP_RECOVERY_CODE` (a
  private backdoor that opens the login box just like the password). **Nothing is hardcoded** — do not
  reintroduce a literal password anywhere (an old one lived in `admin/page.tsx`'s delete gate and in
  `auth.ts`; both were removed). When no password is set, the middleware refuses every cookie (a locked door,
  not a forgeable-open one).
- **Deliberately NOT gated** (machines have no cookie): `/api/webhooks/*`, `/api/slack/*`, `/api/ai/*`,
  `/api/granola/*`, `/api/heartbeat`, `/api/database/purge`. Gating them would break inbound replies and the
  worker. See the allowlist in `middleware.ts`. Env to set: `APP_PASSWORD`, ideally `AUTH_SECRET` and
  `APP_RECOVERY_CODE`.

## Onboarding hub (`/onboarding`)

- A client directory (all clients, ranked by % complete) → per-client checklist snapshotted from an editable
  master template (the "client template box"). Checking a leaf posts to the client's internal Slack channel;
  the last leaf flips the client to complete. Tables: `rr_onboarding_template_steps`, `rr_onboarding_tasks`
  (+ `onboarding_status/started/completed` on `rr_workspaces`). Logic: `shared/onboarding.mjs`,
  `app/lib/onboarding.ts`. **Gotcha already hit:** the tasks table needs `template_step_id`; a partial
  earlier run created the table without it and `create table if not exists` never patches an existing table —
  the snapshot then failed silently (PGRST204). Opening a client lazily snapshots the template.
- The onboarding landing also shows the **meetings webhook URL** as a copyable reference.

## Meetings (`/meetings`)

- Per-client booked meetings. Main source: a Zapier webhook off each client's Calendly at
  `/api/webhooks/meeting/<secret>` (`MEETINGS_WEBHOOK_SECRET`), routed by a `client` field in the payload.
  `shared/meetings.mjs` maps whatever field names the Zap sends. Also add-by-hand, and the assistant's
  `add_meeting` tool. Table: `rr_meetings`. **Gotcha already hit:** the unique index must be NON-partial or
  PostgREST's `on_conflict` upsert raises 42P10 and every Calendly event with an id fails to save.

## Deals & attribution (`/deals`)

- Connect a client's CRM (HubSpot or Attio API key on `rr_workspaces.crm_*`), pull the pipeline into
  `rr_deals`, and attribute each deal. **Attribution is deliberately certain** (`shared/deal-attribution.mjs`,
  fully tested): a deal is `confirmed` only when a person on it matches — by a person-unique id (email or
  LinkedIn) — someone QC contacted (a lead) or booked (a meeting). Company-domain-only is `possible`, flagged
  for review, never counted. QC identity comes from `rr_leads` (LinkedIn) + `rr_meetings` (email + LinkedIn).
  CRM fetch in `app/lib/crm.ts`; **Attio's extraction is unverified against a live workspace** — validate before trusting.

## Jev list check (`/jev`)

Engineers vet a pulled contact list before a campaign launches: client directory → per-client page → drop a
CSV → Run → only the good fits come back. Built on **TypeSafe's Jev** (a "System One" classifier: typed
answers with probabilities, no text generation), reached through **OpenRouter's System One endpoint**
(`POST https://openrouter.ai/api/v1/systemone`, model `jev-1.13`). **Not** the OpenAI-compatible chat
endpoint — it does not serve Jev.

- **Env:** `OPENROUTER_API_KEY` (required). Optional `JEV_MODEL` (default `jev-1.13`, pinned on purpose —
  thresholds are tuned to one model's probabilities) and `JEV_BASE_URL` (default `https://openrouter.ai/api`;
  `https://api.typesafe.ai` with a TypeSafe key works unchanged — same wire format).
- **Per-client question set** in `rr_app_config` under `jev_questions_<slug>` — no migration. Drafted by
  Sonnet from the client's QC Brain folder + client brief (`draftQuestionSet`), then editable. Each question
  is a noul (TypeSafe's name for yes/no) or a choice, with one answer marked "fits".
- **Verdict is a gate** (`verdictFor` in `shared/jev.mjs`): good only if every question's fit-probability ≥
  keep (60%), bad if any < drop (35%), else borderline. Reason = weakest question.
- **The browser parses the CSV and trims each row to a profile** (~380–620 tokens) before sending anything;
  the file never goes to the server whole (a 5k-row AI Ark export is ~30MB, past Vercel's body limit). AI Ark
  exports get a structured profile (headline, About, *every current role*, company description); anything
  else gets a generic column filter. Names, emails, LinkedIn URLs and photos are never sent.
- **Throughput:** browser sends 40-row chunks on 4 lanes to `/api/jev/classify`, which runs 12 at a time
  and streams NDJSON back one line per contact. 5,000 rows ≈ 21s against a ~165ms stub. 429/529/5xx retried
  with backoff.
- **Gotcha already hit:** building CSV fields with `field += ch` made V8 keep per-character ropes — 351MB of
  heap for a 5k-row file. The parser slices by index (72MB). Parity with Python's `csv` verified on real exports.
- **Not verified live** at time of writing: the real OpenRouter response (built to TypeSafe's documented
  shape, `usage.cost` read if present) and the Sonnet draft. Duplicates within the file are removed in code;
  DNC / already-in-`rr_leads` filtering is not built yet.

## Assistant / MCP (`app/lib/assistant-tools.ts`)

New read tools so the assistant covers everything: `slack_channels`, `slack_scan` (full channel history),
`list_meetings`, `list_deals` (with attribution), `onboarding_status`, and the write tool `add_meeting`.
Inboxes/replies and analytics were already covered (`recent_replies`, `awaiting_reply`, `read_conversation`,
`heyreach_*`). Granola call recaps are reachable through the brain (`brain_search`) and Airtable, since call
analysis already writes each recap into `clients/<folder>/Weekly calls/` in the QC Brain.

## MCP chat streaming (UI polish)

The `/mcp` chat reveals streamed answers at a paced rate (a proportional controller in `app/mcp/page.tsx`) so
bursty SSE delivery reads as smooth typing rather than words landing four at a time. The transcript is
memoised so typing in a long chat stays instant.

## Performance passes (from the audit)

Inbox route groups messages by conversation once (was O(conversations×messages)); CRM batch reads run in
parallel and Attio person fetches are concurrency-capped; the assistant caches the workspace list for 30s.
Known follow-ups: CRM API keys are stored plaintext (same pattern as the HeyReach key); the meetings/deals
directory reads are unbounded and will undercount past ~1000 rows.
