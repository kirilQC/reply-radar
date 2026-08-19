# 9. The morning brief

The largest feature added since `context/00`–`08` were written, and none of those files mention it.
Read this before touching anything under `app/api/slack/`, `app/lib/morning-brief*.ts`, `app/slack/`,
or the `sendDueBrief` block in the worker.

State as of `8e8f90a` on `main`.

---

## What it is

Three mornings a week, one short message lands in the team's internal Slack channel for each client.
It is **not** a status report and not a dashboard recap. It answers three questions and nothing else:
what is running, who owes what, and what we are waiting on the client for.

Two Slack messages per client, not one: a one-line header in the channel, and the brief itself as a
**threaded reply** under it. Three page-long briefs a week posted flat turns the internal channel
into a brief archive with the team's actual conversations wedged between them.

> "we're not just writing a static and silly morning brief, this needs to be like an intelligence
> report. it needs to be smart and see things instead of being so linear and just mindlessly
> spitting out call summaries at us."

That sentence is the design brief. Everything below serves it.

## The pieces

| Where | What it does |
|---|---|
| `app/lib/morning-brief.ts` | The prompt, the signal gathering, the post-processing, the trace. ~1,000 lines and the heart of the feature. |
| `app/lib/morning-brief-run.ts` | Resolves which prompt a client gets (per-client override, else global, else default). |
| `app/lib/brain-context.ts` | Reads the client's QC Brain folder for standing context. |
| `app/lib/brain.ts` | The GitHub read behind it: `jsbiv18/qc-growth-os` via `BRAIN_GITHUB_TOKEN \|\| GITHUB_TOKEN`. |
| `app/api/slack/brief/route.ts` | `GET` lists clients and what is due; `POST` writes and sends one brief. |
| `app/slack/page.tsx` | The Slack hub: per-client cards, Generate, the schedule editor. |
| `app/health/page.tsx` | The automation log panel, so a brief that stopped posting is visible. |
| `worker/render-worker.mjs` (`sendDueBrief`, ~line 1253) | The scheduler. **At most one client per cycle.** |
| `app/lib/tracker-extract.ts` | Reads the posted brief back for its action items, as JSON. |
| `app/lib/tracker-sync.ts` | The tracker rules: campaign lifecycle, project upsert, the stale sweep. Pure. |
| `app/lib/tracker-sync-run.ts` | The same rules against a real base. The only half that opens a socket. |
| `tests/morning-brief.test.mjs` | 341 tests as of `8e8f90a`. Most of them are about wording. |
| `tests/morning-brief-sources.test.mjs` | The source gathering half. |
| `tests/tracker-sync.test.mjs` | The tracker rules, including every case that deletes somebody's row. |

### Where the model's input comes from

Five reads in one `Promise.all` (`route.ts:326`), because the calls are the slowest and the most
likely to be missing and must not hold up or fail the others. Neither `gatherCalls` nor
`brainContext` ever throws.

1. **Figures** — `gatherSignals`, computed from HeyReach read live during the run. Facts. The model may
   not restate a figure differently or compute a new one. See below.
2. **The internal channel** — every message of the last fortnight, thread replies indented under the
   message they answer.
3. **The external channel** — shared with the client. Anything said here was said to their face.
4. **The last call** — the full Granola transcript, matched by meeting title.
5. **The client brief and the QC Brain** — what this account is supposed to be doing.

Plus, optionally, **extra channels** and **extra calls** somebody added for context. These are
deliberately second class in the prompt: most extra calls are our own internal meetings, where what
is said is what we *intend* rather than anything the client agreed to. Never the sole basis for a
finding.

### The figures are read from HeyReach during the run

They used to come from `rr_campaign_stats` and `rr_daily_stats`, which the overnight worker fills **one
client per cycle on a 24-hour cadence**. So a brief could state a pending-lead count a full day of
sending out of date, and did:

> "look at this. it just sent the morning brief and the heyreach numbers are off! I WANT LIVE AND
> ACCURATE HEYREACH DATA."

`gatherLiveFigures` in `morning-brief-run.ts` now makes three calls before anything else, all scoped to
this client's own campaigns:

| Call | For | Window |
|---|---|---|
| `/campaign/GetAll` via `campaignStatusFor(key, ALL_STATUSES)` | Every campaign, status and pending count | — |
| `/stats/GetOverallStatsByCampaign` | Sent, accepted and replies per campaign | Pinned to `2020-01-01` for lifetime totals |
| `/stats/GetOverallStats` | The day-by-day series behind this week vs last | 21 days |

Four things about this are load-bearing.

**The statuses are widened to all of them, and the ids come from `CampaignStatus.all`.** The four live
lists are right for "what is live?" and wrong here twice over: a count that omits the finished campaigns
cannot be checked against HeyReach's own screen, and a day series narrowed to the live lists drops the
sends made by a campaign that finished on Tuesday, putting this week's total below the client's own
dashboard.

**Both narrowed calls are given real ids or are not made at all.** HeyReach reads an empty `campaignIds`
as *the whole account*, and several clients ran their own outbound on the same key before the engagement
— which is how the stored series (fetched with `campaignIds: []`) counted their sending as ours.

**All three or none.** A partial read is the worst outcome available: without the rollup every campaign
reports 0 sent, without the series the brief states nothing has been sent in three weeks. Both are
confidently wrong in the direction that starts a conversation about a dead account, and neither is
distinguishable in the output from the truth.

**The fallback is announced, never silent.** The timeout is 12s — knowingly under HeyReach's measured 26s
cold start, because 40 of the route's 60 seconds belong to the model call that has to happen afterwards.
A run that falls back to the stored copy says so in three places: `BriefSignals.source` leads the Figures
block with an instruction to state it once, the HeyReach trace step reads `partial` with the reason on it,
and the provenance is kept in `rr_slack_briefs.signals`. `composeSignals` is the only place the windows,
runway, counts and rates are computed, so a fallback run differs from a live one **only** in what it says
about itself.

## The rules that are load-bearing

Every one of these came from a specific failure. None of them are style preferences.

**Never name a sender we were not given.** Senders are the client's LinkedIn accounts; the people
talking in Slack are our team. A brief once named Shane and Kiril as senders on a Willow campaign and
neither has a HeyReach account:

> "why does the willow report say that Shane and Kiril are the senders for this willow campaign?
> inaccurate. Shane and Kiril arent even in heyreach"

The fix is structural, not a prompt line: `gatherSignals` hands over a names-only `senders` array and
a separate `senderCount`, so where there are no names there is nothing to misread. If the Figures say
the names are not recorded the brief writes the bare count and stops. **Never hand a model an id
where a name goes** — an earlier version printed numeric HeyReach ids as senders.

**Never an em dash or an en dash.** Enforced by a test that scans
`DEFAULT_MORNING_BRIEF_PROMPT`, and by a second test on everything the model is *given*, since it
copies punctuation out of its input.

**Done work is left out entirely.** Not ticked, not mentioned in passing. A list of finished items is
exactly the block of text that made the brief unreadable.

**The channel says done and the Figures say otherwise is the most important item in the brief** —
first under *Things to work on*, owned by whoever said it was done, **once**. An earlier version
printed the same contradiction three times.

**150 to 250 words.** Stated as a number rather than "be concise", because the brief is read on a
phone, standing up, by somebody deciding what to do first.

**The owner's mention starts the line.** Everybody reading is scanning for their own name; a mention
buried mid-sentence is a mention that gets missed, and the item with it.

**Emoji were picked, not guessed.** `:signal_strength:`, `:male-technologist:`, `:hourglass:`,
`:page_facing_up:` (Friday), `:speech_balloon:` (Monday), `:warning:` (runway), `:coffee:` (header).
An earlier round guessed `:bar_chart:` and `:construction_worker:` and both were wrong. A test asserts
the guessed ones never come back. **Ask rather than guess** on anything he can see.

## The brief runs the client's Airtable trackers

The last step of a run, after the brief has been posted. Two tables per client base, matched by name
because tables created after the client bases were duplicated have a unique id per base:

- **Campaign Tracker** — one row per campaign, permanent. Nothing here ever deletes one, because
  "what did BV003 actually do" is a question somebody asks six months later.
- **Project Tracker** — everything else, and only while it is outstanding. Rows are deleted, because
  the tables are read in gallery view as a live answer to "what is open today" and a table that only
  gains rows stops answering that within a fortnight.

**The action items are read out of the brief, not out of the sources.** A second model call
(`tracker-extract.ts`, temperature 0) is handed the brief that was just posted and returns JSON. The
alternative — reading Slack and Granola again — would produce a second opinion, and a tracker that
disagrees with the message the team read that morning is worse than no tracker. This way Airtable is a
projection of the brief and the two cannot drift.

**The board is read before the brief is mined, not after.** `readTrackers` is its own step and runs
first, so the extraction can be shown the keys already on the board and told to reuse them. Reading
afterwards is what filed one client's whole tracker twice: the key is written by a model, so it is only
as stable as the model's wording, and changing the prompt that produces the titles re-slugged all nine
items in Ema Health — the next run created nine second copies instead of updating anything.

**And the matching does not depend on the model obeying.** `sameWork` compares two titles on their
significant words, matching `send` to `senders` on a shared four-character prefix and scoring against
the *shorter* title, because the rewording that causes this is nearly always a shortening. Over 0.6 is
the same item. Where both titles carry a figure and none of them agree it is not — `Add two senders to
BV007` and `Add two senders to BV009` are three quarters the same words and two different jobs, and a
false merge silently loses an item, which is worse than the duplicate.

**A duplicate found on the board is merged away immediately.** Not aged out over `STALE_DAYS`: a second
copy is not evidence of anything, it is this code having written the same note twice, so it goes on the
run that notices it. The keyed row is the one kept, so the key the model just used stays on the board
and the next run matches on the key without ever reaching the fuzzy path. Duplicates are counted apart
from stale removals in the trace, because they mean opposite things — one is work finishing, the other
is a bug showing itself.

**Deleting is only safe because ownership is provable.** `Raised by Brief` is ticked on creation and
checked before every update and every delete. A row somebody typed by hand is never touched, however
stale it looks, never merged into a brief item however alike the titles are, and unticking the box takes
a row out of the brief's reach permanently. One row is only ever claimed by one item.

**A missing item waits five days.** Briefs run three mornings a week, so `STALE_DAYS = 5` is at least
two runs that did not mention it — one thin model run is not destructive. An item somebody explicitly
marks Done goes immediately, because that is a person deciding rather than an absence being read.

**Statuses are resolved, not written.** `CAMPAIGN_STATE_SYNONYMS` maps each lifecycle state to every
word a client base might already use for it, and `resolveChoice` picks whichever the base actually
has. The choice sets have drifted per client and cannot be corrected from the API: Airtable will not
remove a select option, and `typecast: true` would quietly invent one, leaving a client with two words
for the same thing. No match means the figures are still written and the reason lands in the trace.

**A campaign is finished when it runs out of leads, whatever HeyReach says.** A campaign that has sent
to everybody on its list sits at `IN_PROGRESS` in HeyReach forever — nothing switches it off — so
waiting for HeyReach's word would mean no campaign is ever closed. `pending === 0 && sent > 0` is the
end. `pending === 0 && sent === 0` is *not started* and must stay off the board.

**Titles are short on purpose.** `TITLE_MAX = 40`, cut at a word boundary. A gallery card gives the
title two lines and then an ellipsis, and two lines at that width is about forty characters — the first
version shipped at 64 and produced a board where most cards had to be opened to be understood, which is
the flooded view this feature exists to prevent arriving by another route. Fine print goes in `Detail`.

**Owners are names, never user ids.** The brief writes owners as `<@U04AB12CD>` because that is the
only form Slack notifies on, so the same roster the brief was given is handed back to the extraction and
`resolveOwner` translates every mention code and bare id it finds. An id nobody can name is dropped
rather than written through: a column of ids cannot be read or grouped on, and blank is the honest
answer. A group name like "QC Campaign Approval and Launch" passes through untouched.

**Priority is always written.** One of Urgent, High, Medium, Low, defaulting to Medium rather than
blank, because a column that is mostly empty cannot be sorted on. Like every other select it is written
in the base's own spelling via `resolveChoice`, and left out entirely where the base has no such field —
without `typecast` Airtable refuses an unknown option and fails the whole record, which would take the
title and the detail down with the priority.

**The step gets whatever is left of the sixty seconds.** It runs after the post, needs
`TRACKER_BUDGET_MS` to start, and skips with a legible note otherwise. A delivered brief must never
come back as a failed run. Trace step 6 reports it either way, and is absent entirely on runs stored
before the step existed rather than showing them a failure they could not have had.

## Layout is done in code, not asked of the model

The single most useful thing to understand about this file.

`briefFraming` (`morning-brief.ts:750`) takes the model's output and applies the fencing, the
centring and the bullet indents. `briefWithFooter` then appends the weekday reminder. The prompt
tells the model **not** to draw dividers and not to indent headings, and the code strips any it drew
anyway.

Why: **it is fixed padding around a fixed string, and leading whitespace is the first thing a model
tidies away.** Asked for, runs came back with the rule above the heading but not below, or centred by
a different number of spaces each time. Nothing is gained by generating a constant. Doing it in code
also means an old or per-client prompt override cannot leave a stray rule in the middle of a gap.

The current shape, and it is exact:

```
=====================================                 ← 37 equals signs

                    *:signal_strength: _Active Campaigns_ :signal_strength:*

=====================================

1. *BV007: ASCs v2*
    • 106 pending leads (~2 days of sending left)
        • 3 senders: Ali, Abhyuday, Vijay
```

**The indent is computed per line, not a constant.** `centreIndent` measures the line against the
rule using widths taken off a real posted brief: a space ≈ 6.5px, an `=` ≈ 13.9, a letter ≈ 12, an
emoji ≈ 30. An emoji is nearly five spaces wide, **so a heading with two of them cannot be centred by
counting characters** — the first attempt used a flat eight spaces and came out looking left aligned.
A constant also cannot serve both a two-word heading (20 spaces) and Friday's reminder, which nearly
fills the rule on its own (3 spaces) and would wrap at any more. Anything wider than the rule gets
zero, which is correct.

**Sub-bullets step in one indent per bullet**, four spaces then eight. The second bullet is almost
always the accountability clause, which is a comment on the first rather than a sibling of it; two
bullets at the same indent read as one block of text. The counter resets on each numbered item, so
the steps cannot accumulate down a section. Asked for in the prompt *and* normalised in code, because
it is several judgements per brief rather than one.

### The heading regex requires the italics, and that is not cosmetic

```ts
/^\s*\*?\s*:([a-z0-9_+-]+):\s+_([^_]+)_\s+:([a-z0-9_+-]+):\s*\*?\s*$/i
```

`:warning: New leads or a new campaign must be in motion today! :warning:` is structurally identical
to a heading: emoji, words, same emoji. With the underscores optional it was matched as a heading and
fenced into a section of its own with nothing underneath, **which put the single most urgent line in
the brief where it read as a decoration.** The `_…_` is the only thing separating the two.

Found by rendering a realistic brief through the function. Tests, types and lint were all green.

`briefFraming` returns the body **untouched** when it finds no heading at all. An unframed brief is a
cosmetic failure; a truncated one is a lie about the week.

## Things that no longer exist

- **`briefStatusTitle`** and the `*Midweek Status:*` line above the sections. Three sections that each
  announce themselves do not also need a label above them. Removed from the prompt *and* stripped from
  the output by `isStatusTitle`, defensively: a per-client override still carries the old instruction
  and would put the line back on one client only.
- **A separate "Start here" / urgent section.** It meant writing the same finding twice, once at the
  top and once where it belonged. The one `:warning:` line is the entire urgency mechanism.
- **A "Worth knowing" section.** Same reason.

## Operational notes

- **`rr_slack_briefs` is the automation log.** Every attempt including failures, with `status`,
  `error_text`, `destination`, `body` and `signals`. Deliberately not `rr_sync_runs`, which is swept
  at 48 hours — a brief that stopped posting three weeks ago has to still be visible.
- **A preview is not a delivery.** `destination === "preview"` rows are excluded from the health
  counts and dimmed in the list. In the row's className, **test destination before status**: a preview
  that "succeeded" delivered nothing and must not read as a green delivery.
- **The health panel has three states, not two**: running, never run, and *not checked* (no payload at
  all, which is what happens before Supabase is configured). It once asserted "No Slack token is set"
  on the strength of no data. A page that guesses is worse than one that says it did not look.
- **`.health-shell .admin-content` is `display: flex` with an explicit `order` on every child.** A
  panel added without a number defaults to `order: 0` and jumps above the client summary whatever the
  JSX says. The Slack panel is `order: 6`, `.heartbeat-last-checked` is `7`.
- **The worker defaults `destination` to `"test"`** (`worker/render-worker.mjs:1289`), so scheduled
  briefs currently land in `#kiril-automation` rather than the client's internal channel.
- **One client per cycle.** A brief is a 40-second model call plus two Granola calls plus two Slack
  reads; twelve at once would rate-limit and each failure would look like a broken client. One per
  cycle spreads a full roster over about half an hour, which for an 8am brief is invisible.
- **`QC Bot` is not in the internal or external channels for every client** (`canPost: false`).
  `/invite @QC Bot` is still outstanding.
- **The per-client prompt override has no UI field.** The key is `morning_brief_prompt_<slug>`
  (`morningBriefPromptKey`), and it is settable only in the database.

## When a change looks like it did not deploy

It probably did. Check the clock before you debug the code:

```bash
git log -1 --format="%h %ci" && date "+now %Y-%m-%d %H:%M:%S %z"
```

A brief generated in the two or three minutes after a push comes off the **old** Vercel build. This
cost a round of "it looks EXACTLY the same" on formatting that was already correct.

The way to prove the deployed behaviour, rather than argue about a screenshot, is to measure the
characters:

```bash
curl -sL -X POST "https://replyradar.dev/api/slack/brief" \
  -H "content-type: application/json" \
  -d '{"workspace":"bluevia","destination":"preview"}' -o /tmp/prev.json --max-time 120
# then print each line's leading-space count and rule width
```

`destination: "preview"` writes nothing to Slack, so this is safe to run against production. And
`/api/ai/config` returns `defaultMorningBriefPrompt` alongside the live one, which is how you check
whether a deployment carries your prompt change and whether an override is diverging from it.
