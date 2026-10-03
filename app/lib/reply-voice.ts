// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * How a client's team actually answers leads, as examples for the draft model.
 *
 * The draft used to be voiced from "the client's 80 most recent outbound messages". Almost all of those
 * are HeyReach sequence steps (the connection note, the scripted opener, the scripted follow-up), the
 * same paragraph sent to hundreds of people. So the model learned the pitch template, not the team, and
 * every draft came out as a re-pitch in polished AI prose. The examples were also bare, with no sign of
 * what each message was answering, so nothing taught it how the team responds to a "sure, what date?".
 *
 * A reply here is an outbound message sent directly after an inbound one in the same thread: a person
 * answering a person. Anything sent word for word (bar the name) to three or more leads is a template
 * and is dropped even when it lands after a reply. Each example carries the lead message it answered.
 */

import { stripDashLikeHyphens } from "../../shared/no-dashes.mjs";

export type VoiceExample = {
  /** What the lead said. */
  inbound: string;
  /** What the team sent back. */
  body: string;
  senderName: string;
  leadName: string;
  campaignName: string;
  sentAt: string;
};

export type VoiceMessage = {
  conversationId: string;
  direction: string;
  body: string;
  sentAt: string;
  senderName: string;
  campaignName: string;
};

/** A message reduced to its wording: names, numbers, links and spacing stripped, so templates collide. */
export function templateKey(body: string, leadName = ""): string {
  let text = body.toLowerCase();
  for (const part of leadName.toLowerCase().split(/\s+/).filter((p) => p.length > 1)) {
    text = text.split(part).join(" ");
  }
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}]+/gu, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Human replies from a set of threads, newest first. `messages` may hold many conversations in any
 * order; `leadNames` maps a conversation to its lead's name for template detection and labelling.
 */
export function humanReplies(
  messages: VoiceMessage[],
  leadNames: Map<string, string>,
  excludeConversationId = "",
): VoiceExample[] {
  const byConversation = new Map<string, VoiceMessage[]>();
  for (const message of messages) {
    const list = byConversation.get(message.conversationId);
    if (list) list.push(message);
    else byConversation.set(message.conversationId, [message]);
  }

  // How many different conversations each outbound wording appears in. Three or more is a template.
  const spread = new Map<string, Set<string>>();
  for (const message of messages) {
    if (message.direction !== "outbound") continue;
    const key = templateKey(message.body, leadNames.get(message.conversationId) ?? "");
    if (!key) continue;
    const seen = spread.get(key) ?? new Set<string>();
    seen.add(message.conversationId);
    spread.set(key, seen);
  }

  const examples: VoiceExample[] = [];
  for (const [conversationId, thread] of byConversation) {
    if (conversationId === excludeConversationId) continue;
    const ordered = [...thread].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
    for (let i = 1; i < ordered.length; i += 1) {
      const message = ordered[i];
      const previous = ordered[i - 1];
      if (message.direction !== "outbound" || previous.direction !== "inbound") continue;
      const body = message.body.trim();
      if (body.length < 8) continue;
      const leadName = leadNames.get(conversationId) ?? "";
      if ((spread.get(templateKey(body, leadName))?.size ?? 0) >= 3) continue;
      examples.push({
        inbound: previous.body.trim(),
        body,
        senderName: message.senderName,
        leadName,
        campaignName: message.campaignName,
        sentAt: message.sentAt,
      });
    }
  }
  return examples.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
}

/** Same campaign first, then the same sender, then everything else; newest first within each. */
export function pickExamples(
  examples: VoiceExample[],
  { campaignName = "", senderName = "", limit = 12 }: { campaignName?: string; senderName?: string; limit?: number },
): VoiceExample[] {
  const rank = (example: VoiceExample) =>
    (campaignName && example.campaignName === campaignName ? 0 : 2) + (senderName && example.senderName === senderName ? 0 : 1);
  return [...examples]
    .map((example, index) => ({ example, index }))
    .sort((a, b) => rank(a.example) - rank(b.example) || a.index - b.index)
    .slice(0, limit)
    .map(({ example }) => example);
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The measurable habits in a set of replies, said plainly so the model can copy them. */
export function styleNotes(examples: VoiceExample[]): string {
  if (!examples.length) return "";
  const counts = examples.map((example) => words(example.body)).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  const high = counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.8))];
  const share = (test: (body: string) => boolean) => examples.filter((example) => test(example.body)).length / examples.length;
  const greets = share((body) => /^(hey|hi|hello|thanks|thank you|appreciate|great|awesome|sounds)\b/i.test(body));
  const usesName = share((body) => /^\s*(hey|hi|hello)\s+[A-Z]/.test(body) || /^\s*thanks,?\s+[A-Z]/.test(body));
  const exclaims = share((body) => body.includes("!"));
  const lowerStart = share((body) => /^[a-z]/.test(body));
  const signs = share((body) => /\n\s*(best|cheers|thanks|talk soon|-\s*\w+)[,!.]?\s*\n?\s*\w*\s*$/i.test(body));
  const lines = [
    `Length: most replies are ${median} words or fewer, rarely over ${high}. Match that; shorter is better than longer.`,
    greets > 0.5 ? "They usually open with a quick acknowledgement (\"Hey Sam\", \"Thanks for that\")." : "They usually skip greetings and get straight to the point.",
    usesName > 0.4 ? "They often use the lead's first name at the start." : "They rarely open with the lead's name.",
    exclaims > 0.35 ? "Exclamation marks are normal for them." : "They rarely use exclamation marks.",
    lowerStart > 0.3 ? "Casual casing is fine; some replies start lowercase." : "",
    signs > 0.3 ? "They often sign off with a short closing." : "They do not sign off; the message just ends.",
  ];
  return lines.filter(Boolean).map((line) => `- ${line}`).join("\n");
}

/** Phrases that mark a message as machine written. Allowed only when the team itself uses them. */
export const AI_TELLS = [
  "honest take", "valuable context", "exactly why", "that's actually", "great question", "totally understand",
  "i hope this finds you", "circle back", "touch base", "absolutely", "i'd love to learn", "happy to share more",
  "no worries at all", "appreciate you", "in today's", "game changer", "game-changer", "delve", "leverage",
  "synergy", "at the end of the day", "it's worth noting", "rest assured", "don't hesitate", "feel free to",
  "looking forward to hearing", "thanks for reaching out", "more interested in your pushback", "polite yes",
];

/** The tells this client's own replies never use, so the model is told to avoid exactly those. */
export function bannedPhrases(examples: VoiceExample[]): string[] {
  const corpus = examples.map((example) => example.body.toLowerCase()).join("\n");
  return AI_TELLS.filter((phrase) => !corpus.includes(phrase));
}

/** The examples and habits as one prompt block. Empty when there is nothing real to learn from. */
export function voiceBlock(examples: VoiceExample[], clientName: string, senderName: string): string {
  if (!examples.length) return "";
  const shown = examples
    .map((example, index) => {
      const lead = example.inbound.length > 400 ? `${example.inbound.slice(0, 400)}…` : example.inbound;
      const who = example.senderName ? ` (${example.senderName})` : "";
      // Dashes cleaned from our side too: the model copies punctuation, and the drafts must have none.
      return `Example ${index + 1}\nLead wrote: ${lead}\nWe replied${who}: ${stripDashLikeHyphens(example.body)}`;
    })
    .join("\n\n");
  return [
    `HOW WE REPLY. These are real replies the ${clientName} team sent to leads who answered our outreach, each with the message it answered. They are the voice to write in. Copy their length, rhythm, warmth, casing, punctuation and how directly they ask for the next step. Do not copy their facts, offers or dates unless the current conversation calls for the same thing.`,
    senderName ? `You are writing as ${senderName}, in the first person.` : "",
    `<our_replies>\n${shown}\n</our_replies>`,
    `Habits in these replies:\n${styleNotes(examples)}`,
  ].filter(Boolean).join("\n\n");
}
