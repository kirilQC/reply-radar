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
- **It covers the whole product, not just HeyReach.** Our own tables answer reply content, Reply
  Radar's judgement of each reply, who is waiting, and all-time cross-client totals.

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

**Thoroughness beats speed, explicitly.** The first version answered "which of Cotool's campaigns has
the best reply rate" in three seconds off one tool call, and being fast was the whole defect. Thirty
turns and two minutes to be right is the intended behaviour. If a deploy rejects `maxDuration = 300`,
lower that — never `MAX_TURNS`, which is what makes the answers correct.

- **The response is a stream**, which is what makes the long budget bearable: thinking and each tool
  call appear as they happen instead of the user watching a spinner. A buffered response that exceeds
  the platform limit is also lost entirely, where a stream has already delivered everything up to the
  cut.
- **Extended thinking is on** (`budget_tokens` under `max_tokens`, temperature left unset). It is the
  only honest source for the running commentary — the alternative is inventing status lines. Thinking
  blocks must be replayed **with their `signature`**; without it the next request is rejected.
- **`shared/anthropic-stream.mjs` exists because the reassembly fails quietly.** A tool argument glued
  together wrong queries the wrong thing and reports a confident number for it. It is plain ESM with no
  network so `tests/anthropic-stream.test.mjs` can drive it with recorded event sequences, including a
  frame cut mid-way by a chunk boundary.
- **Row budget is 300** (50 for inbox threads, which each carry a full conversation), and id lookups
  are chunked so a 300-row answer is not 300 requests.
- **HeyReach's rate fields have undocumented denominators.** On a live account `messageReplyRate` did
  not reconcile against replies ÷ messages sent. They are exposed as HeyReach's own figures with an
  instruction never to place them beside a count that implies a denominator; to rank by a rate, the
  model divides two raw counts and names them.
**People are searchable by job title, not just by name.** `find_person` matches one named individual;
`search_leads` answers "every CISO in our database", "who do we have at Stripe". Added after "list the
CISOs in our database" gave a good answer one day and a bad one the next — there was no tool for it, so
the model was brute-forcing `recent_replies` and eyeballing roles, which worked or did not depending on
how many rows it happened to pull. An intermittently right answer is worse than a missing tool, because
nothing signals which one you got.

- **Titles are free text**, exactly as each person typed them on LinkedIn, so `role` takes a *list* of
  spellings and matches any of them. The model is told to always pass the acronym and the words behind
  it. A single-spelling search returning nothing is not evidence that nobody matches.
- **The filter is built in `shared/postgrest-filter.mjs`, quoted and stripped.** PostgREST's grammar is
  commas, brackets, dots and asterisks, and job titles contain all four — "VP, Security (EMEA)",
  "V.P. of Engineering". Unquoted, those do not error; they parse as a *different valid filter* and
  return a confidently wrong list. Tested character-for-character.
- **The exact match count comes back beside the rows**, so a capped list is never presented as the
  whole population.

**The answer is a small report — but the report never displaces the answer.** The model is instructed
to lead with the answer, put the finding in a callout, pull out headline figures, show one visual, and
close with the caveat. The first version of that instruction was too strong and a question asking for a
list got a summary and a chart instead of the rows. It now says explicitly that when a list is asked
for the list *is* the answer, that a visual sits beside rows and never instead of them, and that most
answers use only some of the five steps.

- **`MAX_TOKENS` is 16,384 and truncation is announced.** At 8,192 a hundred-row table ran out of room
  and simply stopped, mid-row, which is indistinguishable from a rendering bug. The route reads
  `stop_reason` and appends a line saying the answer was cut off.

It draws by emitting a fenced ` ```chart ` or ` ```stats ` block whose body is JSON — not by calling a
tool, because a tool call happens before the prose is written and the chart would land wherever the
loop put it rather than where it belongs in the argument.

- **Bars are measured from zero, always.** Scaling between a min and a max turns a one-point gap into
  an empty bar beside a full one, which is a picture of a finding that does not exist. `split` is the
  one exception and is measured against the total, because its parts sum to a whole.
- **Charts are CSS, not SVG**, matching every other visualisation in the app. `.md-bars` is a single
  grid with rows set to `display: contents`, so all bars share one axis — a grid per row silently
  gives a row reading "8%" a wider track than one reading "12.5%", and then equal values draw as
  unequal bars.
- **Nothing is silently truncated or silently dropped.** Past twelve bars the remainder is counted and
  reported; a point whose value will not parse keeps its label and draws no bar. Both alternatives
  produce a chart that looks complete and is not.
- **A malformed spec renders as visible JSON.** Ugly enough to get fixed, honest enough not to invent
  a shape for data we could not read. While the turn is still streaming it shows a placeholder
  instead, because mid-stream every spec is temporarily malformed.
- **Print forces the bar colours through** (`print-color-adjust: exact`) and darkens the muted greys.
  Browsers drop backgrounds when printing, which would otherwise print every chart as empty tracks.
**Streaming text has to be cheap to redraw, and the cost is not the parser.** Parsing a whole answer
measures around 80ms spread across its entire arrival. What made typing feel laggy was what each
redraw dragged with it, so three things changed: the answer repaints once per animation frame rather
than once per delta; `Markdown` is memoised, because the page re-renders on every frame and that was
re-parsing every *earlier* answer in the conversation too, making a long transcript type more slowly
than a fresh one; and the follow-the-tail scroll is instant rather than smooth, since restarting a
smooth scroll fifty times a second makes the page hunt instead of follow. Neither scroll drags the
page back down if the reader has scrolled up.

- **A streaming answer is split at the last blank line and rendered as two runs** (`splitSettled`).
  Even memoised and frame-limited, it was still laggy, because the real cost is React reconciling the
  *whole* growing answer sixty times a second — a finished forty-row table is around a thousand fibers
  and every one was re-checked per frame, which is why the lag grew with the answer rather than being
  constant. Once a blank line has landed nothing above it can be revised by later characters, so the
  settled run's only prop is a string that does not change and React skips it entirely. Fences are the
  one exception and are tracked, because a split inside an open ` ```chart ` would cut a JSON spec in
  half. `Blocks` returns a fragment, not a wrapper, so every block stays a direct child of `.md` and
  the first-child margin rules still apply.
- **Answers are rendered markdown, and exportable.** `shared/markdown-blocks.mjs` parses to blocks so
  tables and bold render rather than showing their pipes and asterisks. CSV is lifted out of the
  answer's own tables rather than asking the model for a second machine-readable copy, which would
  double the tokens and give two versions of the same numbers that could disagree. PDF is
  `window.print()` with print CSS, as in Reports.
- **Export is offered when asked for, not permanently.** The Copy/CSV/PDF row under every answer was
  three buttons of furniture on answers nobody exports. The model now emits an ` ```export ` fence
  naming the formats when the question implies one, and that renders as buttons. The handler is
  threaded as `onExport` plus a numeric `exportKey` rather than a closure per message, deliberately:
  a fresh arrow function per render would defeat the memo above and reintroduce the lag it shipped
  beside.
- **The memo boundary that actually mattered is the table row.** After two failed attempts the third
  started with a measurement instead of a hypothesis, and it disproved both earlier ones: on a
  200-row answer `splitSettled` settled **68 characters and left 28,642 in the tail**, because a
  markdown table contains no blank line and the split has nothing to cut at. Long lists are the
  answers this feature exists to produce, so the boundary had to go lower. Each row and each list
  item now carries the raw line it was parsed from as a memo key and parses its own cells, turning a
  frame from re-diffing every cell into one string comparison per row. `Turn` is memoised for the
  same reason at the other end of the scale — the tenth question was redrawing the nine answers above
  it sixty times a second, which is why the tab got slower the longer it was used.
- **The follow-the-tail scroll is throttled to roughly six times a second, not once per frame.**
  Reading `scrollHeight` forces the layout React has just invalidated to be recomputed synchronously
  and `scrollIntoView` invalidates it again — a full-page reflow per frame, on a document holding a
  growing table. The layout cost was the same order as the render cost it was chasing.
- **The page vetoes which download buttons an answer may draw, not the model.** Two things are
  invisible from inside the model's own output: whether its prose actually contains a grid — a CSV
  holding the question and one sentence of judgement is a file nobody wanted — and whether a real
  file was already streamed down beside the answer, which produced a second, worse *Download CSV*
  next to the true one, offering to rebuild a lead list out of prose. `answerHasRows` and the
  presence of delivered files decide it, passed down as a comma-joined **string** so that the prop
  itself cannot break the memo.

**The running commentary is interleaved with the lookups, not concatenated onto the answer.** A
question needing four lookups is four round trips and the model writes a sentence before each one.
Those used to be appended to the same answer buffer, which produced two failures at once: the
sentences ran together with no space where one turn ended and the next began — `…find the right
one!Found it —` — and a stack of lookups sat above a paragraph trying to introduce them one at a
time. Each sentence is now closed into a `note` entry the moment a tool call starts, so it sits
directly above the lookup it explains, and the missing space is fixed as a consequence of the
structure rather than by patching whitespace. The system prompt asks for one short sentence before
each round of calls, and for the answer itself only after the last one.

**A delivered list is filtered by re-exporting it, never by editing the file.** "Just the CTOs from
that list" was answered with "I can't filter a file I've already given you", which was true and
useless. `heyreach_export_list` takes `titleContains`, `companyContains` and `nameContains`, re-fetches
from HeyReach, filters server-side and delivers a second file — so the rows still never touch the
model. An empty result reports how many rows were searched and says job titles are free text, rather
than implying nobody matches.

**A lead list exported as CSV must never pass through the model.** `heyreach_export_list` builds the
file on the server and returns it beside the tool result under a `__file` key that `takeFile` strips
before the result is sent to Claude; the model sees a summary and is told it cannot reproduce the
rows. A list retyped by a language model is not the list — it is a very good imitation of one, and
nobody looking at the file could tell.

**Attachments go to the model as native content blocks.** Images and PDFs as base64 `image`/
`document` blocks, everything else decoded to text, capped so a large file is refused rather than
silently truncated. Files lead the turn they were attached to, before the question.

**`rr_conversations.score` and `.tier` are dead columns and nothing has ever written to them.** The
assistant read them and produced the worst kind of wrong answer: asked for the best replies of the
day, it reported that "the scoring engine hasn't processed today's conversations yet" and ranked them
by reading the text itself. Nothing was behind schedule and nothing was ever going to arrive. What the
pipeline actually writes is nested in `raw_data.reply_radar` — `sentiment`, `followup_urgency` and
`followup_reason` on the message, `icp_score` on the lead — which is what the inbox already ranks by,
and now what the assistant reads, so the two cannot disagree. Null there means unanalysed, not zero.

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
