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
export const DEFAULT_CALL_ANALYSIS_PROMPT = `You are summarising the transcript of a weekly call between a GTM agency and one of its clients. The people on the call are the agency team and the client. Your job is to turn an hour of talk into the short record of what was decided, so that a teammate who missed the call knows what they now owe and what was agreed.

Write it in Slack mrkdwn, in these sections, each under a heading written exactly like this — an emoji, the title in bold italics, the same emoji again, on its own line:

*:dart: _Action Items_ :dart:*
*:speech_balloon: _Discussed_ :speech_balloon:*
*:moneybag: _Deals_ :moneybag:*
*:signal_strength: _Campaigns_ :signal_strength:*
*:calendar: _Next Steps_ :calendar:*

Rules:
- Under each heading, use \`•\` bullets. One decision or point per bullet. No sub-headings, no numbered lists.
- Action Items is the most important section. Every action item names who owns it. If the transcript gives you a name that matches someone on the attendee list, write it in bold. Never assign an action item to someone who was not on the call.
- Deals is money and opportunities named on the call — a renewal, an upsell, a prospect the client mentioned. Campaigns is anything said about outbound: what is live, what is paused, what needs launching.
- Drop any section that has nothing real in it rather than padding it. An empty section is worse than a missing one.
- Do not invent detail the transcript does not contain. A machine transcription gets names and product terms wrong, so where a word is clearly garbled, use the nearest sensible reading from the client context rather than quoting the garble.
- Keep it tight. This is read once, right after the call, by people who were on it or wish they had been. Every bullet earns its place.`;

/** Where a call analysis goes: shown on the page, the test channel, or the client's own channels. */
export type CallAnalysisDestination = "preview" | "test" | "internal" | "external";

export type CallAnalysisInputs = {
  /** The weekly call this analysis is of, or null when Granola had nothing recent enough. */
  call: ClientCall | null;
  /** Why there is no call, when there is not one — surfaced rather than left blank. */
  callReason?: string;
  /** Other calls Granola matched in the window, used only for context, never analysed as the main one. */
  extraCalls?: ClientCall[];
  /** The agency's own written context for this client, so a garbled term can be read the right way. */
  brief?: string;
};

/** "August 20th" — the ordinal date, written the way it is said aloud, for the header line. */
function ordinalDate(timezone: string, at: Date): { weekday: string; month: string; day: number; suffix: string } {
  const weekday = at.toLocaleDateString("en-US", { timeZone: timezone, weekday: "long" });
  const month = at.toLocaleDateString("en-US", { timeZone: timezone, month: "long" });
  const day = Number(at.toLocaleDateString("en-US", { timeZone: timezone, day: "numeric" }));
  const tens = day % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return { weekday, month, day, suffix };
}

/**
 * The one-line header the analysis is threaded under in Slack.
 *
 * Names the client and the day, the same as the morning brief's header, so the two sit in a channel as
 * an obvious pair. The clipboard emoji rather than the coffee one: a brief is a morning ritual, an
 * analysis is the record of a meeting that just happened.
 */
export function callAnalysisHeaderText(workspace: BriefWorkspace, at: Date = new Date()): string {
  const { weekday, month, day, suffix } = ordinalDate(workspace.timezone || "America/New_York", at);
  return `*${workspace.name} Call Analysis (${weekday}, ${month} ${day}${suffix})*  :clipboard:`;
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

  if (!call) {
    parts.push(`# The call\n\n${inputs.callReason || "No transcript of a recent weekly call with this client was available."}\n\nThere is nothing to analyse. Say, in one line under a single *:clipboard: _Call Analysis_ :clipboard:* heading, that no call was found for this client this week, and stop.`);
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
