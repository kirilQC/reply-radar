// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Who started a conversation, shared by the Next.js app and the Render worker.
 *
 * Reply Radar exists to work outbound replies. A prospect who found us and messaged us first is
 * not part of that motion, so scoring them wastes Anthropic calls and clutters the queue.
 *
 * Who sent the first message decides it. That is the whole rule, and it is deliberately the only
 * rule that can return "outbound" off the back of the thread itself — earlier versions let a
 * campaign name short-circuit the comparison, which is how cold DMs kept getting through. The one
 * thing that outranks the message order is HeyReach confirming the lead is enrolled in a campaign,
 * because a campaign can open with a connection request instead of a message.
 *
 * Where the evidence runs out, this abstains: "unknown" rather than a guess in either direction.
 *
 * Nothing is stored. The verdict is derived from the messages every time it is needed, which means
 * correcting a rule immediately re-includes anyone it had been excluding — no backfill, no stale
 * flag on a row that a later fix can no longer reach.
 */

/** @param {unknown} value @returns {Record<string, unknown>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {});
/** @param {unknown} value @returns {string} */
const text = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");
/** @param {unknown} rawData @returns {Record<string, unknown>} */
const radarOf = (rawData) => object(object(rawData).reply_radar);

/**
 * Campaign names that HeyReach itself stands behind, as opposed to ones we scraped or guessed.
 *
 * A bare campaign name used to be treated as proof that we had targeted someone. It was not: the
 * ingestion path was synthesising attribution from whatever campaign the sending account happened
 * to be running, so a cold DM from a stranger arrived stamped with a real campaign name and sailed
 * through this file as "outbound". That is why lead-initiated conversations kept reappearing in the
 * inbox no matter how many times the rule below was tightened.
 *
 * `source` now records where a name came from (see `CampaignSource` in app/lib/heyreach-conversation.ts)
 * and only HeyReach's own webhook envelope and its confirmed enrollment answer count. Messages
 * written before that field existed carry no source, so they prove nothing — which is deliberate:
 * those are exactly the rows that need re-judging on the evidence in the thread.
 */
const TRUSTED_CAMPAIGN_SOURCES = new Set(["webhook", "membership"]);

/**
 * @param {Record<string, unknown>[]} messages
 * @returns {boolean}
 */
function hasVerifiedCampaign(messages) {
  return messages.some((message) => {
    const campaign = object(radarOf(message.raw_data).campaign);
    return TRUSTED_CAMPAIGN_SOURCES.has(text(campaign.source)) && Boolean(text(campaign.id) || text(campaign.name));
  });
}

/**
 * @typedef {object} OriginVerdict
 * @property {"outbound" | "inbound_lead" | "unknown"} origin
 * @property {string} reason Plain English, so the inbox can explain why a row was set aside.
 */

/**
 * @param {object} input
 * @param {Record<string, unknown>[]} input.messages Every stored message for the conversation, any order.
 * @param {unknown} [input.leadRawData] The lead's `raw_data`, read for how complete the history is.
 * @returns {OriginVerdict}
 */
export function classifyConversationOrigin({ messages, leadRawData }) {
  const rows = (messages || []).map(object).filter((row) => text(row.direction));
  if (!rows.length) return { origin: "unknown", reason: "No messages are stored for this conversation yet." };

  // Confirmed enrollment is the one thing that outranks the message order, and it earns that only
  // because it covers campaigns whose first touch is a connection request: the lead's first
  // *message* is then genuinely inbound, but we are the ones who went and found them.
  if (hasVerifiedCampaign(rows)) {
    return { origin: "outbound", reason: "HeyReach confirms this lead is in one of our campaigns, so we approached them." };
  }

  // A webhook that arrived without its conversation history leaves us holding the newest messages
  // only. The first message we have is then not the first message that exists, and "the lead spoke
  // first" cannot be concluded from it. Positive confirmation is required rather than merely the
  // absence of a warning: ingestion stamps this on every lead it writes, so a row without it was
  // written by something older, and guessing on those is how a real outbound lead would vanish.
  const historyStatus = text(radarOf(leadRawData).history_status);
  if (historyStatus !== "complete") {
    return { origin: "unknown", reason: historyStatus
      ? `Only part of this conversation was retrieved from HeyReach (${historyStatus}), so who messaged first is unknown.`
      : "The full conversation history has not been confirmed for this lead, so who messaged first is unknown." };
  }

  const sorted = [...rows].sort((a, b) => {
    const left = new Date(text(a.sent_at)).getTime();
    const right = new Date(text(b.sent_at)).getTime();
    return (Number.isNaN(left) ? 0 : left) - (Number.isNaN(right) ? 0 : right);
  });
  if (sorted.some((row) => Number.isNaN(new Date(text(row.sent_at)).getTime()))) {
    return { origin: "unknown", reason: "A message in this conversation has no usable timestamp, so the order cannot be trusted." };
  }

  if (text(sorted[0].direction) === "outbound") {
    return { origin: "outbound", reason: "We sent the first message in this conversation." };
  }
  return { origin: "inbound_lead", reason: "The lead sent the first message and HeyReach does not have them in any campaign, so they approached us." };
}

/** Convenience for the common case: should this conversation be worked as an outbound reply? */
export const isLeadInitiated = (input) => classifyConversationOrigin(input).origin === "inbound_lead";
