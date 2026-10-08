// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A lead who sends two or three messages in a row ("Sounds great" then "Looking forward to the session")
 * gets ONE Slack reply alert, not one per message. The messages are a burst: inbound, back to back, with
 * nothing from us between them and no more than BURST_GAP_MS between one and the next. The newest message
 * of a burst carries the card (showing the whole burst); the earlier ones are folded into it. Pure, so
 * tests/reply-burst.test.mjs drives it.
 */

/** Messages further apart than this are separate replies, each with its own card. */
export const BURST_GAP_MS = 3 * 60 * 1000;
/** How long a burst must be quiet (no newer message from the lead) before its card is posted. */
export const QUIET_MS = 25 * 1000;

const at = (message) => Date.parse(String(message?.sentAt ?? ""));
const sorted = (messages) => [...(messages || [])].filter((m) => Number.isFinite(at(m))).sort((a, b) => at(a) - at(b));

/** The burst a message belongs to, oldest first: the run of inbound messages around it with no outbound between. */
export function burstOf(messages, target) {
  const list = sorted(messages);
  const index = list.findIndex((m) => m.id === target.id);
  if (index < 0) return [target];
  let start = index;
  while (start > 0 && list[start - 1].direction === "inbound" && at(list[start]) - at(list[start - 1]) <= BURST_GAP_MS) start -= 1;
  let end = index;
  while (end < list.length - 1 && list[end + 1].direction === "inbound" && at(list[end + 1]) - at(list[end]) <= BURST_GAP_MS) end += 1;
  return list.slice(start, end + 1);
}

/** The newest message of the target's burst when that is a later one (so the target's card is folded into it), else null. */
export function laterInBurst(messages, target) {
  const burst = burstOf(messages, target);
  const last = burst[burst.length - 1];
  return last && last.id !== target.id ? last : null;
}

/** What the card shows as the lead's latest reply: every message of the burst, in order. */
export function burstText(messages, target) {
  return burstOf(messages, target).map((m) => String(m.body ?? "").trim()).filter(Boolean).join("\n\n");
}
