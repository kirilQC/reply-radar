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
- **Verdict is a score with vetoes** (`verdictFor` in `shared/jev.mjs`). It used to be an all-must-pass gate
  (every question ≥ 60%), and a vetted 500-contact Bluevia list came back 20 good fits (4%) — six gates compound,
  and "unclear" counted as a fail. Now each question has a `kind`: `must` drops a contact only below the drop line
  (35%); `exclude` drops only when the disqualifier is ≥ 80% sure; `signal` only moves the score. Choice options
  in `neutral` ("unclear") make that question count for nothing when most of the answer lands there. Good = the
  average of counted must/signal answers ≥ 60%. Sets saved before kinds existed: a no-is-fit noul is `exclude`,
  the rest `must`.
- **Suggest tags from Other** (company mode, after a run): the companies left in Other (their list data plus any
  scraped website facts) go to `anthropic/claude-sonnet-5` via OpenRouter (`JEV_SUGGEST_MODEL`), which proposes new
  tags with descriptions, example companies and counts, and names the ones that are genuinely out of scope. Nothing
  is saved until someone ticks and adds them; then "Re-tag N" re-runs only the Other + Needs review rows (scrapes are
  cached). Live on the 240-company file: 14 in Other → 3, in ~21s. Tag labels with a leaked instruction ("tag each
  company as one of the following: Health System") are repaired on load by `stripInstruction`.
- **Long typed tag lists** (Bluevia: 169 tags): a "A | B | C" list is saved at once with no model call, keeping
  any description a tag already had; the browser then fills the missing descriptions 25 tags a request, four at a
  time, via `/api/jev/tags/describe` (Sonnet 5 on OpenRouter, the full name list as context) and saves once.
  Writing them all in the build request timed out at 52s. Typed lines of the form "Name: description" (or
  "Name — description") keep their own description (`parseTagEntries`; split only when a sentence follows, so
  "Post-Acute: Skilled Nursing" stays a name) and are never sent to the model. The typed text cap is 200,000 characters (4,000 and then 12,000
  each silently dropped the end of a real list; Bluevia's 188 described tags are ~30,000); prose sent to a model is
  cut at 12,000 separately. Measured: 169 described in ~32s; 240 companies tagged against all 169 in 4.5s,
  ~8.4k Jev tokens a company (~$0.00035), Other 14 → 6, Needs review 6 → 25 (finer neighbours, lower margins).
- **Review with Claude** (company mode, after a run): rows in Other or Needs review go to `anthropic/claude-sonnet-5`
  via OpenRouter (`JEV_REVIEW_MODEL`), 8 a request, 3 at a time, with the full tag set as a cached system block.
  Each company comes back as an existing tag, a proposed new tag (with a description), or unplaced — always with a
  reason, held to the tag set by `parseReview`. Rows update live with a CLAUDE badge; proposals are merged across
  batches (`mergeProposals`) and can be adopted into the set (rows already carry them). A cut-off answer is split in
  half and retried — a 15-company batch overran the output cap live. Measured: 24 leftovers on 188 tags, 19 placed,
  1 new tag, 31s, $0.10; Needs review 23 → 3.
- **Stale-tab guard:** the client bundle carries `NEXT_PUBLIC_BUILD_ID` (the commit, set in `next.config.ts`) and
  `/api/jev/questions` returns the server's; on a mismatch the page shows "Reply Radar was updated — Reload" and
  blocks Run. Added after an old tab ran Bright Data-era pipeline code against the AI Ark server and skipped every
  contact lookup silently.
- **Contact setup has two ways in:** a Prompt tab (free text → Sonnet writes the questions) and the ICP form.
  The question writer now goes through OpenRouter (`anthropic/claude-sonnet-5`, `JEV_BUILD_MODEL`) when that key is
  set, Anthropic direct otherwise — one key runs the whole feature.
- **Must-haves decide, signals rank.** With any `must` question, good = every must ≥ keep; signals only feed `score`
  (exported as "Jev fit score"). Averaging signals into the verdict put "VP of Provider Growth at a Medicaid-focused
  company" in Borderline on a Vitalic "any Medicare/Medicaid/MA connection" run because a generic title failed the
  "own role" signal. With no must-have, the average still decides.
- **Contact lists up to 30,000 rows.** A 20k-row, 250-column AI Ark export (125MB) loads in 2s at ~280MB heap and
  runs at ~300 rows/s against a stub (real Jev ~80–120/s).
- **Structured contact ICP** (`icp` on the question set; `app/jev/[slug]/icp.tsx`): a pool of target titles
  (turned into one Choice question verbatim by `titlePoolQuestion` — never paraphrased), responsibilities,
  company size range (checked in code by `sizeCheck` against `listed_company_profile.employees`; unknown size is
  left out, not failed) and exclusions. The question writer is told to be generous and to leave titles and size
  alone.
- **The browser parses the CSV and trims each row to a profile** before sending anything; the file never goes
  to the server whole (a 5k-row AI Ark export is ~30MB, past Vercel's body limit).
- **Any export works — columns are classified, not matched by name** (`planColumns` in `shared/jev.mjs`). Each
  header is read for meaning (company-scoped first, so "Company Description" is not the person's; numbered job
  history like "1st Experience Title" / "Experience 2 Company" / "job_3_title"; JSON job-history lists as Clay
  exports them), and a header that says nothing is judged by its values (links, ids, numbers, dates and
  one-value-on-every-row columns are ignored; other text is sent as `other`, capped at 8 columns).
  Tested against AI Ark, Apollo, Sales Nav, Clay and hand-made headers. The page's **Columns** panel shows how
  every column was read and lets an engineer override it.
- **The profile shape is fixed** (`listed_title`, `listed_company`, `headline`, `about`, `seniority`,
  `department`, `location`, `skills`, `current_roles[]`, `listed_company_profile{industry, employees,
  description, products, funding, revenue, location, type}`, `other`), so one question set works on every
  file. Questions name these fields in backticks; `missingFields` warns on the page when a file lacks a field a
  question depends on. Names, emails, LinkedIn URLs and photos are never sent.
- **Throughput:** browser sends 40-row chunks on 4 lanes to `/api/jev/classify`, which runs 12 at a time
  and streams NDJSON back one line per contact. 5,000 rows ≈ 21s against a ~165ms stub. 429/529/5xx retried
  with backoff.
- **Gotcha already hit:** building CSV fields with `field += ch` made V8 keep per-character ropes — 351MB of
  heap for a 5k-row file. The parser slices by index (72MB). Parity with Python's `csv` verified on real exports.
- **Describe box** (both modes): a teammate types what they want in plain words; `POST /api/jev/build` has Sonnet
  turn it into the setup (with the client's Brain + brief as background, the description leading) and saves it.
  For company tags typed as "A | B | C", `mergeNamedTags` keeps every typed tag verbatim and in order — the
  model only writes descriptions.
- **Company lists** (`?mode=companies`): one Choice over the client's tag set (`jev_tags_<slug>` in
  `rr_app_config`), each tag sent as "Label: description" so neighbours can be told apart; an Other tag is always
  added. Below `minConfidence` (60%) a company is "Needs review", with the runner-up shown. Profile = name,
  industry, description (+SEO), products, employees, locations, type, funding, revenue, location. De-duplicated
  by website, then LinkedIn page. Up to 100k rows; 6 lanes.
- **Measured live** (real Jev via OpenRouter, 2026-09-23): 240 companies in 2.2s through the app (~110/s, $0.01);
  113 contacts ~1s ($0.005). Response shape matches TypeSafe's docs; model reported as `typesafe/jev-1.13-20260917`.
  At 100k companies against a stub: 2s to load a 115MB file, ~384MB heap, no long tasks, export 0.6s.
- **Enrichment pipeline** (both modes; `shared/enrich.mjs` pure, `app/lib/enrich.ts` I/O, driven from the browser by
  `app/jev/[slug]/pipeline.ts`): **CSV → Jev first pass → scrape → GPT-6 Luna structures → Jev final pass.**
  Auto mode (default) scrapes only rows Jev is unsure about or whose data is thin (`missingData`: a company needs a
  real description; a contact needs headline/About + current roles + any field the questions name). A contact Jev
  rules out clearly (any question < 15%) is never scraped. "Every row" and "Off" do what they say.
  - Companies: the company's own website, fetched directly (browser headers — a bare UA got a firewall page), home
    + About when the home page is short; bot walls/parked/error pages are rejected by `unusablePage`, never sent to
    the model. SSRF-guarded (private IPs, localhost, redirects). `JINA_API_KEY` optional fallback for JS-only sites.
  - Contacts: **AI Ark People Search** (`AI_ARK_API_KEY`, the same key the inbox's lead enrichment uses), 100
    LinkedIn URLs per call via `lookupPeople` in `app/lib/ai-ark-enrichment.ts`, matched back by normalised URL.
    AI Ark's record is already structured, so contacts are mapped in code (`aiArkFacts`/`mergeAiArk`) and **skip the
    LLM entirely**. Current roles = positions with no end date, with `employment_type` kept ("Freelance" is how an
    advisory-board listing shows). The employer's description is only attached when it matches the listed company.
    0.5 credits per person found; unknown URLs cost nothing. Replaced a Bright Data scrape (async polling + an LLM pass,
    and LinkedIn had largely stopped exposing experience). `AI_ARK_BASE_URL` overrides the host for tests.
  - Structuring: `openai/gpt-6-luna` (`JEV_STRUCTURE_MODEL`), reasoning off, strict JSON schema, null when the source
    doesn't say, verbatim evidence. **6 rows per call** with row ids, because **OpenRouter caps new accounts at 20
    requests/min per model** (hit live). The browser paces to `JEV_STRUCTURE_RPM` (default 18) and holds a batch on
    429 instead of failing it; a cut-off answer is retried as halves. Solar Mini was rejected: it copied a firewall
    error page into "customers".
  - Website facts go under `from_website`; LinkedIn fills empty contact fields and adds `from_linkedin` (the CSV is
    never overwritten). Enriched profiles are cached per file so re-runs don't pay twice. Exports add
    "Enriched: …" columns with the evidence.
  - Measured live: 60 thin companies (name + website) → 54 read, 54 structured, re-tagged in 42s for ~$0.013 total.
    Full 240-company file on Auto scraped only 33 rows. Contacts through an AI Ark double (documented response shape) + real Jev: 20 contacts in 2.4s, one call.
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
