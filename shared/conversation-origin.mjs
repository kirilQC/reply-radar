/**
 * Who started a conversation, shared by the Next.js app and the Render worker.
 *
 * Reply Radar exists to work outbound replies. A prospect who found us and messaged us first is
 * not part of that motion, so scoring them wastes Anthropic calls and clutters the queue. The
 * hazard is the opposite mistake: wrongly classifying a real outbound lead hides a live deal, and
 * a hidden deal is far more expensive than an extra row. So this is written to abstain rather than
 * guess, and every rule that returns "inbound_lead" has to get past the guards below first.
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
 * A HeyReach campaign on any message in the thread proves we targeted this person, whatever the
 * messages say. This is the guard that saves campaigns whose first touch is a connection request
 * rather than a message: the lead's first *message* is then genuinely inbound, but they are still
 * someone we went out and found.
 *
 * @param {Record<string, unknown>[]} messages
 * @returns {boolean}
 */
function hasCampaignAttribution(messages) {
  return messages.some((message) => {
    const campaign = object(radarOf(message.raw_data).campaign);
    return Boolean(text(campaign.id) || text(campaign.name));
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

  if (hasCampaignAttribution(rows)) {
    return { origin: "outbound", reason: "This conversation is attributed to a HeyReach campaign, so we started it." };
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
  return { origin: "inbound_lead", reason: "The lead sent the first message and this conversation is not attributed to any campaign, so they approached us." };
}

/** Convenience for the common case: should this conversation be worked as an outbound reply? */
export const isLeadInitiated = (input) => classifyConversationOrigin(input).origin === "inbound_lead";
