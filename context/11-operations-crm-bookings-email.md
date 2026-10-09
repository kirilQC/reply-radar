# QC Command: Operations, CRM push, booked meetings, email channels (Oct 7 to 9, 2026)

What was built after `10-new-sections.md`. Everything here is on `main`, deployed (Vercel, production
`www.replyradar.dev`) and covered by `npm test` unless a line says otherwise. **Reply Radar is called "QC
Command" in every user-facing string since 2026-10-01**; internal names (`rr_*`, `reply_radar` JSON key,
`reply-radar-*` storage keys, the domain) were deliberately kept. Use "QC Command" in new UI text.

Read `08-session-handoff.md` (top addendum) for what is open right now.

---

## 1. The Client Operations page (`/operations/<slug>`)

One **Operations** button on a client's onboarding page opens a full page (the "Control Room" design Kiril
picked from 10 concepts). Left rail of destinations, one view each:

| View (`?view=`) | What it is |
|---|---|
| `hubspot` | Connect a service key, read-only audit, approved build, push replies, deals for booked meetings, reports and dashboard |
| `attio` | Same flow for Attio |
| `sheets` | Any number of Google Sheets, each holding replies, booked meetings or campaigns |
| `airtable` | Any number of Airtable tables, same three contents |
| `meetings` | The booked meetings workflow (section 4) |

- Files: `app/operations/[slug]/page.tsx`, `app/components/ClientOperations.tsx`, `app/operations/operations.css`
  (`ops-*`, `bk-*` classes; keep dark and `body.light-mode` tokens). The old pop-up `OpsCockpit.tsx` is deleted.
  `/bookings/<slug>` redirects to `?view=meetings`. HubSpot, Google and Calendly sign-ins return to this page.
- A client uses **one CRM**: the other is greyed out and locked, the chosen one outlined green.
- **Pulse check** at the top: "As of <date>, replies and deals are flowing", or a big red alert per problem
  with its fix. Tiles include live **Ours (from QC)** contacts and deals.
- A built HubSpot/Attio shows **three boxes** (Replies, Booked meetings, Dashboard), each with the last person
  added / last booked meeting turned into a deal, linked to the CRM record (`pulseOf` in the crm-push route).
- **Build log** is numbered with timestamps; created green, reused yellow, failed red.
- Setup steps are numbered badges with generous spacing (Kiril asked for this on every setup view).

## 2. CRM push (HubSpot and Attio)

Tables: `rr_crm_push` (one row per destination: `provider` hubspot | attio | sheets | airtable, `kind`,
`config` JSON), `rr_crm_push_records` (lead to CRM record), `rr_crm_push_meetings` (meeting to deal).
Migrations `20261009_crm_push*.sql`, `20261009_many_sheets.sql`, `20261009_airtable_push.sql` (all run).

- Flow: **connect → read-only audit → plan → approved build → idempotent push → automatic sync**
  (`/api/crm-push/sync`, worker-driven). Code: `app/lib/hubspot-push.ts`, `attio-push.ts`, `crm-push-run.ts`,
  `crm-push.ts`, `crm-sync-status.ts`, route `app/api/crm-push/[slug]/route.ts` (`maxDuration` 300; a manual
  pass stops starting batches after 150s).
- **One push at a time per destination** (`withPushLock`, shared by sync, Push all, Push 1 lead and QC Bot).
  Verified: three simultaneous pushes give one run and two 409s, on all four destinations.
- **Kiril's rule: QC never assigns its leads to the client.** QC Growth owns every contact QC brings in (owner
  filled only where empty), because the attribution matters.
- HubSpot fields: name/email/title/company/domain/company LinkedIn go into HubSpot's standard fields; QC data
  in a minimal set of `qc_*` properties (LinkedIn URL unique, campaign, sender, platform, sentiment, reply
  count, first/last reply, latest reply, conversation, booked meeting). "Only our contacts" filter:
  `qc_outreach_platform IN (heyreach, lemlist, email_bison)`.
- **Scopes.** `REQUIRED_SCOPES` in `hubspot-push.ts` (17: contacts/companies/deals objects r+w, schemas
  contacts/companies/deals r+w, `crm.objects.owners.read`, `crm.lists.read+write`, `settings.users.read+write`).
  The connect step lists each one as its own bullet; a test keeps list and UI in step. **`scopeGate`** re-reads
  the key's scopes live before every build (HubSpot and Attio) and refuses with 400, naming each missing scope,
  before anything is created. Attio: `ATTIO_REQUIRED_SCOPES`.
- **Booked meetings become deals** in a **Booked Meeting (QC)** stage of the client's chosen pipeline, owned by
  QC Growth, linked to contact and company, deal named for the company, with meeting/outreach/pre-call brief as
  fields and a note; reschedules and cancels update the same deal; one deal per person across repeat bookings;
  QC's own test bookings skipped. **Never skip this stage** (Kiril, explicit): a key that cannot see deals blocks
  Approve and build. HubSpot's API keeps a pipeline's original first stage first, so the QC stage lands second;
  `ensureStageFirst` logs the truth (non-blocking); moving it first is a drag in HubSpot Settings.
- **Reports and dashboard** need a *user-level* token, not the service key: QC Growth's own HubSpot app
  (`hubspot-app/`, app id 56379102, dev account 52147363; upload with `npx -p @hubspot/cli@latest hs project
  upload` from that folder). `app/lib/hubspot-user.ts` (OAuth; region host for na2/eu1 portals or the login
  loops), `hubspot-reporting.ts` (7 HubSQL reports + "QC Growth" dashboard). Dashboards also need the portal
  enrolled in HubSpot's **Reporting API beta**: the page links straight to the client's
  `/product-updates/<portal>/in-beta?puQuery=api&rollout=327896`. Nothing is built until the beta is live
  (otherwise duplicates). Reports cannot be deleted by API (405), so extra copies are reused and logged as
  "skipped". Views made by API are private to the app identity (HubSpot limitation).
- **Attio**: workspace key; people kept clean (filled only where empty) plus a `qc_linkedin_url` match key (Attio
  refuses unique custom text); QC data on a "QC Growth" list; one note per conversation updated in place. The
  API cannot make views/dashboards; the **QC Dashboard** Attio app lives in `qc-growth-dashboard/` (excluded from
  the Next tsconfig; ship with `npx attio version create`).

## 3. Google Sheets and Airtable (tables)

- One writer for both (`app/lib/table-push.ts`: `isTable`, `tableContent`, `writeTable`, `tableItemsPass`) over
  `sheets-push.ts` / `airtable-push.ts`. Each sheet or table holds **one** content: `replies` (17 standard
  fields), `meetings` (21) or `campaigns` (19, the **campaign tracker** from `rr_campaign_stats`: added on launch,
  refreshed on status change and weekly; state in `config.campaign_state`). `STANDARD_FIELDS` is the source.
- **Sheets**: sign in once as admin@qcgrowth.com (Google OAuth, app-wide, server side; the service account is
  the fallback). Columns are found by header name on every push (reordering is safe); a hidden **QC ID** column
  keeps one row per lead; QC house formatting. Many sheets per client, and other tabs of the same spreadsheet.
- **Airtable**: QC's `AIRTABLE_API_KEY`. Base pre-picked from `rr_workspaces.airtable_base_id`, else closest
  name; a table is pre-selected only on a clear name fit or when it is the base's only table (it once suggested
  "Onboarding Responses"). Records found again by a **QC ID** field, written by field id with `typecast`, 220ms
  spacing. **"Create the table for me"** makes a typed table with every standard column.
- **Missing columns are added automatically** on connect or content change (both Sheets and Airtable) with a note
  naming them.
- **Once confirmed, a table's content is locked**: the Replies / Booked meetings / Campaigns switch becomes
  "Holds ..." and the server refuses a content change (409). Remove the destination to change it.
- Routes: `app/api/sheets-push/[slug]`, `app/api/airtable-push/[slug]` (GET `?bases=1`, `?base=`; POST create,
  connect, reread, content, map, push, auto, disconnect).

## 4. Booked meetings workflow (`?view=meetings`, "Design A")

Per client: Calendly or cal.com booking → shared **Clay** table for enrichment → QC's pre-call brief →
Slack post → CRM deal / sheet / table / webhooks. Code: `app/components/BookingSetup.tsx`,
`app/lib/booking-run.ts`, `app/lib/booking-connect.ts`, `shared/bookings.mjs`, routes under
`app/api/bookings/*`, `app/slack/BookingAlerts.tsx`. Migration `20261008_booking_alerts.sql`
(`rr_workspaces.booking_config`, `calendly_token`, `calendly_subscription`, `calcom_secret`, `rr_meetings.booking`).

- Page: pulse headline, progress, six numbered step cards that **autosave**.
- **About section is never typed by a person**: "Write it for me" (`app/api/bookings/about/route.ts`) uses
  `claude-sonnet-5-5` with `thinking: {type: "between_tools"}` and web search, reading the QC Brain, the client
  brief and the client's website; keeps only text after the last tool block; dedupes sources; no em dashes.
- **Calendly**: each client connects its own (personal access token or OAuth) and ticks the event types that run
  the workflow; QC subscribes its webhook (organization scope when the token's user is an admin).
  **`GET /api/bookings/calendly/check`** (read-only, behind the password) reports, for every connected token, the
  user, role, event types and whether it may read meetings / create event types / create one-off events / book
  invitees (probed with empty POST bodies: 400 = allowed, 401/403 = not; nothing is created).
- **Clay**: test form (name, email, company, job title + client name) sends a row to the shared Clay table,
  `meeting_id test:<workspaceId>`; Clay posts back to the callback URL with a JSON body. Typed test values win
  over Clay's. Photos and logos are filled from AI Ark by the LinkedIn Clay returns. **A test runs the whole
  workflow** (brief + Slack post to `SLACK_TEST_CHANNEL_ID`), never stored, no deal.
- **Campaign attribution** after enrichment (`attributeCampaign`): QC's leads, then the client's HeyReach by
  LinkedIn, then email; QC's coded campaigns first; saved on the booking with its source.
- **Slack card** (`buildBookingCard`): sections `expand: true` (never collapsed), `*Meeting #N*` (+ " ·
  rescheduled") in the main post, never "first meeting with this lead" text. Image accessory on the right,
  **company logo first** (Clay/AI Ark logo, then Google's favicon service by domain from the company or a work
  email; Clearbit's logo service is dead), lead photo only when no logo. If Slack cannot fetch the image the
  post is retried without it.

## 5. Email channels and Slack reply alerts (Oct 7 to 8)

- **Email Bison** (`send.qcgrowth.com`): one workspace token per client on `rr_workspaces.emailbison_token`; only
  "Tracked Reply" rows are real; replies read per campaign; conversations keyed `bison:<lead id>`.
  `app/lib/emailbison.ts`, `email-ingest.ts`, `/api/emailbison/status`. Migration `20261009_email_channel.sql`.
- **lemlist** as a third reply source, treated like HeyReach: per-client key via the Connect panel, one webhook
  URL per channel, conversations keyed `lemlist:<contactId>:<channel>`, figures stored with `lemlist:` ids.
  `app/lib/lemlist*.ts`, `shared/lemlist-text.mjs` (LinkedIn text lives in `text`, email in `message`).
  Migration `20261010_lemlist.sql`. Clients on lemlist: Reach, Bead, ZeroPath.
- Inbox has a channel filter and a solid blue envelope badge on email threads; drafts are channel-aware;
  out-of-office replies never reach the inbox or Slack.
- **Slack reply alerts**: every lead reply posted to the client's replies channel with thread + send; a lead's
  back-to-back messages fold into one card (25s quiet window). Migration `20261007_reply_alerts.sql`.
- **QC Bot never @mentions Luke** (`SLACK_NEVER_PING`, enforced in every Slack send helper).

## 6. Assistants (Scout, MCP, QC Bot)

- Tools `crm_sync_status` and `crm_push_now`; readiness, System health and help know about CRM, Sheets, Airtable
  and the campaign tracker. Credential tables are sealed from `query_data`.
- **Client-written brain notes are untrusted.** Clients can now write into `clients/<folder>/from-client/` of the
  QC Brain through the QC Portal connector. `brain_read` fences that text as `<client_written_note
  untrusted="true">` and `brain_search` flags `writtenByClient` (`app/lib/assistant-tools.ts`).
  `shared/markdown-blocks.mjs` only renders links to `http(s)`, `mailto:`, in-app `/` paths and `#`.

## 7. The QC Portal side (repo `kirilQC/qc-portal`, `www.qcgrowth.dev`)

Not this repo, but tied to it:

- **Brain connector**: each client's own Claude (claude.ai, desktop, Claude Code) connects to their QC Brain
  folder by a link shown on their Brain tab: `/api/mcp/brain/<qcb_ token>` (stateless MCP JSON-RPC). Tools:
  `list_brain_files`, `read_brain_file`, `search_brain`, `write_client_note` (writes only to `from-client/`).
  Code: `app/lib/brain-connector.ts`, `app/api/mcp/brain/[token]/route.ts`, `app/api/brain/connector/route.ts`.
- The link is **derived** (HMAC of workspace id + when it was made, keyed by `SESSION_SECRET`), only its hash is
  stored (`rr_brain_connectors`), so every client sees it automatically; "Reset link" makes a new one.
- **Pentest (Bluevia, 2026-10-09)**: 28 traversal/encoding payloads, search containment, 22 write-escape names,
  token tampering, batch/size limits, 30 parallel calls: **no cross-client read or write**. Writes landed only in
  `clients/bluevia-health/from-client/`; test notes deleted. Fixes shipped: client-style write paths fold into
  the client's own corner; a new note lists immediately. **Bluevia's workspace has `offboarded_at` set** (the
  portal does not block offboarded clients, so the connector does not either).
- The portal keeps a verbatim copy of `shared/campaign-code.mjs`; change both together.
