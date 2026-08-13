# 6. Product decisions already made

Decisions the owner has settled. **Do not relitigate these, and do not re-add anything listed as
removed.** Where a decision reversed an earlier one, both are recorded, because the earlier version
looks reasonable and will otherwise get rebuilt.

---

## Cold inbound leads are not "set aside" — they are gone

**Current:** conversations the lead started, with no campaign attribution, are excluded from the
inbox entirely and can be permanently purged from the database.

**History, which matters:** the first implementation set them aside behind a review affordance so
they could be inspected. That was rejected outright:

> "i dont want to review them... its trash to me."

**Therefore:** excluded data gets no UI. No review queue, no "hidden items" count, no expandable
tray. The inbox logs exclusions **server-side only** (`reply_radar_inbox_dropped_orphaned`). The
purge exists precisely because "excluded" wasn't enough — the owner wanted them deleted.

**But the classifier still abstains.** Wrongly excluding a real outbound lead hides a live deal, which
is far more expensive than an extra row. "Trash it" applies to leads we're **certain** approached us
cold, not to leads we can't classify. Uncertain → `unknown` → stays in the inbox.

---

## Deletion means gone from everything

**Reported as:** "when i delete a lead, can you please verify they are fully gone? from everything."

**Therefore:** deletion is person-scoped (every `rr_leads` row sharing the profile URL), removes
children explicitly, counts what it removed, reads the tables back, and returns `502` if anything
survived. "Probably deleted" is not acceptable.

The owner also asked for a **backfill**: "can you also go back and delete any leads that reached out
to us first?" With no local credentials, the only honest delivery was a button —
`POST /api/database/purge`, two-phase.

**Two judgement calls made and disclosed rather than assumed:**

1. The purge also cleans **orphaned** conversations, since those are equally invisible and equally
   wreckage.
2. A **lead row is only deleted when every conversation of theirs was lead-initiated.** If they also
   have a thread we opened, only the cold thread goes. A genuine outbound lead is never thrown away.

---

## Numbers must be exact and honest

**Reported as:** "in the live database heading, can we please replace x loaded to x amount of total
leads in the database."

**Therefore:** counts come from the database (`count=exact`), never from the length of the page that
happened to be fetched. When filters are active the label says "matching leads"; otherwise "total
leads in the database". The wording changes with what is being counted.

The same standard produced `/api/analytics/summary` rather than reusing `/api/analytics`, whose
"total" was a capped page.

---

## Only campaigns we launched are ours to report on

**Reported as:** "the client engagement duration is wrong for a few clients … some of these clients
tried to do outbound in heyreach before they hired us, so sometimes we have campaigns that predate
us. ALL of the campaigns we launch have the same style of prefix … thats how we know which campaigns
are ours."

**Therefore:** every campaign QC launches is named with a short client code and a sequence number —
`CT003`, `SW019`, `W040`. Campaigns without one belong to the client's own pre-engagement attempts and
are dropped where the HeyReach payload is read, so nothing downstream can count them. The rule lives
in `shared/campaign-code.mjs` and applies to new campaigns automatically; the only maintenance is
naming ours correctly in HeyReach.

The pattern is deliberately looser than the convention as stated, because the live accounts are not
uniform — one to three letters, an optional colon, two or three digits. The reasoning, and the real
campaign names that forced each allowance, are in that file's header. It is a rule about *whose work
this is*, so widening it to rescue an oddly-named campaign is worse than renaming the campaign.

**Known casualties, to be renamed in HeyReach rather than coded around:** Cotool's "Cotool Linkedin
Followers", "Maxwell ICP Campaign (new)" and "Max ICP campaign" are ours but carry no code, so they
are currently excluded.

---

## The home page

**Asked for:** "the analytics at the top are so bare bones. can you please make it better. i want to
see total replies today, total replies this week, total replies this month, and all time total
replies, and total number of clients set up."

**Built:** five tiles — Today (with a `▲/▼ N vs yesterday` delta), This week, This month, All time,
Clients set up. Exact counts. The clients tile shows profile count as its hint and uses the accent
colour.

**Also explicitly liked and therefore not to be redesigned:** "i really like how the profiles and
client workspaces look." Leave those two sections alone.

**Section order on the home page:** stats → profiles → clients. Profiles above client workspaces was
an explicit earlier requirement. Four client cards should fit on a row when space allows.

**"Performance overview" is removed and should not come back.** It held a reply-volume line chart, a
queue-mix donut and a workspace snapshot, all fed by `/api/analytics`. Once the five exact stat tiles
landed it was saying the same thing less clearly:

> "can we get rid of the perfromance review from the dashboard since we now have those replies boxes
> on the homepage."

Removing it also took `/api/analytics` off the home-page load path, which is a real saving — that
route pages through HeyReach. The route itself still exists for other callers.

---

## Time and locale

- **"Today" is the reader's today**, from their saved time zone preference
  (`reply-radar-prefs:general` → `appearance.timeZone`), not the server's.
- **Weeks start Monday.** A Sunday start makes Monday morning look like a fresh week had barely
  begun, and this is read as a working-week report.
- Default client timezone is `America/New_York`.
- An unusable saved zone falls back to UTC rather than erroring.

---

## Scoring defaults

New clients must be scored from day one. `awaiting-us` is the default follow-up template and
`general-seniority` the default ICP template, and the scoring routes apply them **even while the ICP
panel is locked**. A client nobody has configured yet gets vetted defaults, not silence.

The client brief is threaded into the ICP prompt **above** the criteria.

`/api/ai/templates` is a **shared, named prompt library** — any teammate can save a prompt from the ＋
button and everyone gets it. This came from the owner wanting to make things easier for teammates.

---

## Inbox and navigation

- General inbox title is **"General inbox"**. Client inbox shows the client name and logo. Profile
  inbox shows the profile name and assigned-client chips.
- **Removed and not to return:** "Priority inbox" wording, hardcoded `12` / `Hot 4`, the question-mark
  help button, the "Rotate key" and "Backfill" buttons (they had no backend), the row of 20–30 client
  cards in admin (replaced with a searchable directory).
- Filter and sort must actually work.
- Client cards route to **that client's** inbox, not the general inbox.
- Clicking a client in admin opens a dedicated client page, not a dropdown.
- Layout customisation is per profile, falling back to device preferences for the general inbox.
  Appearance applies globally and persists.

---

## Client configuration

Per-client fields: name, slug, website, logo, HeyReach API key, full webhook URL, timezone, client
brief, AI model, temperature, system prompt, scoring rules, theme/accent, documents.

- Saves must survive a hard refresh.
- Document upload opens the real file picker and persists to Supabase Storage.
- Adding or removing a client must update every live view: sidebar, home, general inbox, profile
  assignment choices.
- "Date created" belongs at the bottom of the client page, not on the directory card.
- Workspace deletion is gated by the password `QueenCity@2026`. This is an **internal speed bump, not
  authentication** — do not treat it as a security control or build on it.

---

## Heartbeat

Two views, both required:

- **Basic** — plain language for Supabase, Anthropic, the Render worker and each client, explaining
  what each check means and showing success / attention / missing.
- **Advanced** — raw timestamps, ages in seconds, HTTP status, worker cycle metadata, error text, row
  counts, sync run details, webhook and poll timestamps, raw JSON.

**Never call something healthy because a row exists.** Use explicit timestamps and freshness
thresholds.

---

## MCP

The tab is **called MCP and is not one.** It is an Anthropic tool-use loop on our own server, named
after the thing people already understand. Do not rename it to be technically correct.

- **Model is `claude-sonnet-4-6`.** Everything else in the app runs Haiku; this reasons over many
  tools across many turns and Haiku is not enough for it.
- **Read-only, structurally.** No write function exists in `app/lib/heyreach-api.ts` and no mutating
  tool exists in `app/lib/assistant-tools.ts`. `tests/heyreach-api.test.mjs` fails if one is added, so
  reopening this is a deliberate act rather than a slip.
- **No authentication.** Internal only, consistent with the rest of the app.
- **It covers the whole product, not just HeyReach.** Our own tables answer reply content, scores,
  tiers, who is waiting, and all-time cross-client totals.

**Numbers come from one source per question, never averaged across the two.** `rr_messages` has no
`workspace_id`, so per-client and windowed counts come from HeyReach, which is authoritative and
supports date ranges; content, scoring and follow-up state come from our tables.

Three HeyReach behaviours that will produce confidently wrong answers if forgotten:

- **`leadsContacted` is zero on every per-campaign row** and only populated on the workspace total.
  It is excluded from campaign metrics; `connectionsSent` is the number that answers it.
- **`searchString` on `inbox/GetConversationsV2` matches the person's name, not message text.** It is
  exposed to the model as `nameContains` for that reason. There is no message-content search.
- **`filters` must be nested** in the conversations request body. Flattened, it is silently ignored and
  returns the whole inbox.

---

## Permanently out of scope

Do not build these. They were considered and de-scoped:

- **Authentication of any kind.**
- **Webhook secret verification.**
- **Encryption of HeyReach API keys at rest.**

---

## Open, unresolved

- Whether the worker's `APP_BASE_URL` should point at `replyradar.app` rather than the `.vercel.app`
  deployment. Never answered.
- Subdomain analytics needs `ROOT_DOMAIN`, wildcard DNS, and the wildcard domain added in Vercel.
  None of it is configured.
- One earlier request was truncated mid-sentence and never completed: "i also want to make it a little
  easier for my teammates trying to…". The shared prompt library may have been the intent, but it was
  never confirmed.
