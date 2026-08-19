// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The weekly call analysis: the prompt, the header, and the content the model reads.
 *
 * ── Why this is the morning brief's sibling, not its twin ────────────────────────────────────────
 * A morning brief is three sources — campaign figures, Slack channels, the last call — reconciled into a
 * short list of what is outstanding. A call analysis is one source: the transcript of the weekly client
 * call, turned into what was decided on it. Same shape of output (fenced Slack headings, `•` bullets,
 * people mentioned by id) so the two read alike in the channel and the website renders both, but the
 * inputs and the point are different. The brief asks "what still needs doing"; the analysis asks "what
 * did we just agree to".
 *
 * ── Why the arithmetic-free half still lives apart from the I/O half ─────────────────────────────
 * The same split the morning brief keeps, for the same reason: this file has no relative value imports,
 * so a test can load it and assert on the prompt and the content directly, without a Granola key or a
 * clock. The reads and the Anthropic call live in `call-analysis-run.ts`.
 */

import type { ClientCall } from "./granola";
import type { BriefWorkspace } from "./morning-brief";

/** The config key for a per-client prompt override, or the global one when no slug is given. */
export function callAnalysisPromptKey(slug?: string | null): string {
  const trimmed = String(slug ?? "").trim();
  return trimmed ? `call_analysis_prompt_${trimmed}` : "call_analysis_prompt";
}

/**
 * The default instructions, written to produce the same Slack shape the morning brief does.
 *
 * The heading format is load-bearing and identical on purpose: `*:emoji: _Title_ :emoji:*`, because that
 * exact shape is what `briefFraming` fences on the way to Slack and what the website's parser reads back
 * into headings. Change the emoji here and both still work; change the underscores or the asterisks and
 * a heading renders as a plain line in one place and a section title in the other.
 *
 * Attribution is the whole value of the exercise. A call analysis that says "someone will send the
 * proposal" is a note; one that says "<@U…> will send the proposal" is a commitment with a name on it,
 * which is why the transcript is handed over with its speaker labels intact and the model is told to keep
 * them. Machine transcription gets names wrong, so the roster of who was actually on the call is given
 * too, and the model is told to map a mangled name to the nearest attendee rather than invent one.
 */
export const DEFAULT_CALL_ANALYSIS_PROMPT = `You are writing the recap of a weekly call between a B2B outbound growth agency and one of its clients. The people on the call are the agency team and the client. Your job is to turn an hour of talk into the short record of what was decided, so a teammate who missed it knows in thirty seconds what was agreed and what they now owe.

This reads like the morning brief, because it lands in the same Slack channel and the same people read it. Short, scannable, and written like a colleague wrote it, not a machine.

## What to write

**The whole recap is 200 words at the very most.** It is read once, right after the call, on a phone. Every line earns its place, and a line that restates the one above it does not. If you are writing a second sentence on a point, you are writing too much.

These sections, in this order. **Drop a section entirely if the call had nothing real in it** — an empty section padded out is worse than a missing one.

### :signal_strength: _Campaigns_ :signal_strength:

Anything said about outbound: what is live, what is paused, what needs launching, what is running dry. One campaign or point per numbered item.

### :moneybag: _Deals_ :moneybag:

Money and opportunities named on the call: a renewal, an upsell, a prospect the client raised, a deal won or lost. One per numbered item.

### :dart: _Action Items_ :dart:

The most important section. What somebody now owes, off the back of this call. **The owner's mention is the first thing on the line**, because everybody reading is scanning for their own name:

1. <@OWNER> to *do the specific thing*
    • _the one detail that makes it actionable, only if it is not obvious._

Every action item names who owns it. Work out the owner from who volunteered or was asked on the call. Never assign one to somebody who was not on the call.

### :speech_balloon: _Discussed_ :speech_balloon:

The decisions and context worth keeping that are not an action or a deal. One point per numbered item, one line each.

### :calendar: _Next Steps_ :calendar:

What happens next and when: the next call, a deadline somebody named, a thing to revisit. Only if the call actually set one.

## Rules

- **Never use an em dash or an en dash.** Not one, anywhere. No \`—\`, no \`–\`. They are the clearest tell a machine wrote this. Use a comma, a colon, a semicolon, brackets, or two sentences.
- **Keep every line short.** One point, one line. The detail sub-bullet is a single clause, not a sentence. If it needs a paragraph, it is two points and you should pick the one that matters.
- Do not invent detail the transcript does not contain. A machine transcription gets names and product terms wrong, so where a word is clearly garbled, use the nearest sensible reading from the client context rather than quoting the garble.
- Do not open with a title, a date or a greeting. Open on the first section heading. Do not close with a summary or a question. End on your last point.

## Formatting

Slack mrkdwn, which is not markdown. *bold* with single asterisks, _italic_ with underscores. **There is no underline in Slack.** No \`#\` headings, no \`**double asterisks**\`, no tables, no code fences, no \`===\` divider lines: they render as literal characters and make the recap look broken. The rules that fence each heading are added for you afterwards, so do not draw them and do not indent the headings.

- **Section headings** are the emoji, the name in bold italics, the same emoji again, on their own line hard against the left margin: \`*:signal_strength: _Campaigns_ :signal_strength:*\`. Use the five given above, spelled exactly that way. Nothing else on that line.
- **Items are numbered**: \`1.\`, \`2.\`, \`3.\` at the start of the line. The numbering restarts in each section.
- **Sub-bullets** start with \`•\` and are indented under the item they belong to. At most one per item, and never a second unless it says something the first does not. There is no blank line between an item and its own sub-bullet.
- **One blank line between one numbered item and the next.**
- **Mention people with their mention code from the mention table**, \`<@U04AB12CD>\`, so the owner is actually notified. Copy it exactly. A name typed as plain \`@kori\` reaches nobody. Anyone not in the table (the client's own people) is written in *bold* plain text.
- **Bold marks the thing itself** — the campaign name, the action to be done, the deal. Not the whole sentence. Italics are for the one detail clause and nothing else. Every \`*\` and \`_\` must be closed.

A worked example of the shape and the spacing, content stripped out. Match this. It opens on the first heading, there is not an equals sign in it, and no line is indented except the sub-bullets:

*:signal_strength: _Campaigns_ :signal_strength:*


1. *BV007: ASCs v2* ready to relaunch with ~300 filtered contacts
2. *BV009: Ortho Offices* paused pending new copy


*:moneybag: _Deals_ :moneybag:*


1. *Intermountain Health* lost, competitor already embedded, keep warm for 6 months
2. *UCSF / Kleiner Perkins* incubation, warm intro made, top live opportunity


*:dart: _Action Items_ :dart:*


1. <@U01> to *send campaign updates to the client*
    • _agreed on the call, nothing out yet._

2. <@U02> to *pull the ASC LinkedIn list*


*:speech_balloon: _Discussed_ :speech_balloon:*


1. ASC list scraped to ~2,000, matched to LinkedIn, ~300 usable contacts
2. Health system IT committees flagged as a structural blocker to deals


*:calendar: _Next Steps_ :calendar:*


1. Revisit GI as a segment once the ortho learnings are proven`;

/** Where a call analysis goes: shown on the page, the test channel, or the client's own channels. */
export type CallAnalysisDestination = "preview" | "test" | "internal" | "external";

/** The four destinations, spelled as the Weekly Calls `Posted To` options are. `typecast` is never set. */
const POSTED_TO: Record<string, string> = { preview: "Preview", test: "Test", internal: "Internal", external: "External" };

/**
 * One Weekly Calls row from a finished analysis, as a fields object Airtable takes verbatim.
 *
 * Pure, so the shape is asserted without a base. Keyed on the Granola note id in `Call ID`: the run
 * writer looks a call up by it and updates that row rather than filing a second recap for the same
 * meeting on a re-run. `Call Date` is the day of the call in the client's zone (not today), so a view
 * grouped by it reads the weeks in order. A field with nothing to say is left off rather than written
 * blank — an empty duration is not a zero-minute call.
 */
export function callAnalysisRow(
  workspace: BriefWorkspace,
  input: { call: ClientCall; recap: string; destination: CallAnalysisDestination; syncedAt?: Date },
): Record<string, unknown> {
  const timezone = workspace.timezone || "America/New_York";
  const row: Record<string, unknown> = {
    Title: input.call.title,
    "Call Date": new Date(input.call.startedAt).toLocaleDateString("en-CA", { timeZone: timezone }),
    Recap: input.recap,
    "Posted To": POSTED_TO[input.destination] ?? "Preview",
    "Call ID": input.call.noteId,
    "Last Synced": (input.syncedAt ?? new Date()).toISOString().slice(0, 10),
  };
  if (input.call.attendees.length) row.Attendees = input.call.attendees.join(", ");
  if (input.call.owner) row.Host = input.call.owner;
  if (input.call.durationMinutes) row["Duration (min)"] = input.call.durationMinutes;
  return row;
}

export type CallAnalysisInputs = {
  /** The weekly call this analysis is of, or null when Granola had nothing recent enough. */
  call: ClientCall | null;
  /** Why there is no call, when there is not one — surfaced rather than left blank. */
  callReason?: string;
  /** Other calls Granola matched in the window, used only for context, never analysed as the main one. */
  extraCalls?: ClientCall[];
  /** The agency's own written context for this client, so a garbled term can be read the right way. */
  brief?: string;
  /** The QC Brain block for this client, the same standing context the morning brief is given. */
  brain?: string;
  /**
   * Who is in this client's Slack channels, so an action item owner can be mentioned by the code that
   * notifies them. The same roster the morning brief is handed — the agency team who own the work.
   */
  people?: { id: string; name: string }[];
};

/** "August 20th" — the ordinal date, written the way it is said aloud, for the header line. */
function ordinalDate(timezone: string, at: Date): { month: string; day: number; suffix: string } {
  const month = at.toLocaleDateString("en-US", { timeZone: timezone, month: "long" });
  const day = Number(at.toLocaleDateString("en-US", { timeZone: timezone, day: "numeric" }));
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return { month, day, suffix };
}

/**
 * The one-line header the recap is threaded under in Slack.
 *
 * "{Client} Weekly Sync Recap (August 18th)". The date is the day of the *call*, not today, because a
 * recap run on Wednesday of a Monday call is a recap of Monday's meeting and dating it Wednesday reads as
 * a mistake. No weekday, unlike the morning brief: a brief is a thing that happens on a given morning, a
 * recap is about one meeting and the calendar date is what names it. The thread emoji says at a glance
 * that the recap itself is the reply below.
 */
export function callAnalysisHeaderText(workspace: BriefWorkspace, at: Date = new Date()): string {
  const { month, day, suffix } = ordinalDate(workspace.timezone || "America/New_York", at);
  return `*${workspace.name} Weekly Sync Recap (${month} ${day}${suffix})*  :thread:`;
}

/**
 * What the model is shown, in the order it should read it: who was on the call, the client context, and
 * then the transcript itself.
 *
 * The context comes before the transcript because it is what a garbled product name is read against; the
 * transcript comes last because it is the bulk of the input and the thing everything else is scaffolding
 * for. The attendee list is stated in words because the model is told to attribute action items to it,
 * and machine transcription mangles names — a roster to map back to is the difference between "Kiril will
 * do it" and a name that was never on the call.
 */
export function callAnalysisUserContent(workspace: BriefWorkspace, inputs: CallAnalysisInputs): string {
  const timezone = workspace.timezone || "America/New_York";
  const today = new Date().toLocaleDateString("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" });
  const brief = String(inputs.brief ?? workspace.client_brief ?? "").trim();
  const call = inputs.call;

  const parts: string[] = [`Today is ${today}. You are analysing the weekly call for ${workspace.name}.`];

  if (brief) {
    parts.push(`# Who this client is\n\nUse this only to read garbled names and product terms correctly. Do not report from it.\n\n${brief}`);
  }

  // The QC Brain, the same standing context the morning brief reads. Reference material, not this week's
  // news: it is here so a mangled product name or an unfamiliar segment can be read the right way, and so
  // the recap knows what this account is meant to be doing when the call touches on it.
  const brain = String(inputs.brain ?? "").trim();
  if (brain) parts.push(brain);

  // The mention roster, built exactly as the morning brief's is: the people in this client's Slack
  // channels, name and mention code together. The recap names an owner on every action item, and a name
  // in plain text is a name the owner never sees, so the model is handed the codes to copy verbatim.
  const roster = (() => {
    const byId = new Map<string, string>();
    for (const person of inputs.people ?? []) {
      if (person.id && person.name && !byId.has(person.id)) byId.set(person.id, person.name);
    }
    if (!byId.size) return "";
    const lines = [...byId].map(([id, name]) => `- ${name} → <@${id}>`).join("\n");
    return `# How to mention people\n\nWhen the recap names an action item owner, write their mention code from this table exactly as it appears, including the angle brackets. Slack turns it into a real mention that notifies them; their name typed as plain text does not. Machine transcription mangles names, so match a garbled name on the call to the nearest person here. Anybody not in this table, including the client's own people, is written in bold plain text, never with a made-up code.\n\n${lines}`;
  })();
  if (roster) parts.push(roster);

  if (!call) {
    parts.push(`# The call\n\n${inputs.callReason || "No transcript of a recent weekly call with this client was available."}\n\nThere is nothing to analyse. Say, in one line under a single *:thread: _Weekly Sync Recap_ :thread:* heading, that no call was found for this client this week, and stop.`);
    return parts.join("\n\n");
  }

  const when = call.ageDays === null ? "on an unknown date" : call.ageDays === 0 ? "today" : call.ageDays === 1 ? "yesterday" : `${call.ageDays} days ago`;
  const attendees = call.attendees.length ? call.attendees.join(", ") : "not recorded";
  const duration = call.durationMinutes ? `${call.durationMinutes} minutes` : "an unknown length";
  const cut = call.truncated ? "\n\nOnly the last part of the transcript is included; the earlier portion was too long to pass on." : "";

  parts.push(
    `# The call: "${call.title}", ${when}`,
    `Recorded by ${call.owner || "an unknown host"}, ${duration} long. On the call: ${attendees}.`,
    `## Transcript, in full\n\nA machine transcription, so names and product terms are unreliable. This is the whole call. Read it for what was decided and who owns each action.${cut}\n\n${call.transcript}`,
  );

  return parts.join("\n\n");
}
