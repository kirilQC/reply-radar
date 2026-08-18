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
| `tests/morning-brief.test.mjs` | 341 tests as of `8e8f90a`. Most of them are about wording. |
| `tests/morning-brief-sources.test.mjs` | The source gathering half. |

### Where the model's input comes from

Five reads in one `Promise.all` (`route.ts:326`), because the calls are the slowest and the most
likely to be missing and must not hold up or fail the others. Neither `gatherCalls` nor
`brainContext` ever throws.

1. **Figures** — `gatherSignals`, computed from our own records. Facts. The model may not restate a
   figure differently or compute a new one.
2. **The internal channel** — every message of the last fortnight, thread replies indented under the
   message they answer.
3. **The external channel** — shared with the client. Anything said here was said to their face.
4. **The last call** — the full Granola transcript, matched by meeting title.
5. **The client brief and the QC Brain** — what this account is supposed to be doing.

Plus, optionally, **extra channels** and **extra calls** somebody added for context. These are
deliberately second class in the prompt: most extra calls are our own internal meetings, where what
is said is what we *intend* rather than anything the client agreed to. Never the sole basis for a
finding.

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
