/**
 * Message direction and identity, shared by the Next.js app and the Render worker.
 *
 * The worker runs as plain ESM (`node worker/render-worker.mjs`) so it cannot import the
 * TypeScript modules under `app/lib`. Keeping this logic in JavaScript that both sides load
 * is the point: while the worker held its own copy it disagreed with the app about who sent
 * a message, which stored the same message twice under opposite directions and made our own
 * outreach appear in the inbox as if the lead had written it.
 */

import { createHash } from "node:crypto";

/** @param {unknown} value @returns {Record<string, unknown>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {});

/** @param {unknown} value @returns {string} */
const text = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

/** @param {Record<string, unknown>} row @param {string[]} keys @returns {unknown} */
const first = (row, keys) => keys.map((key) => row[key]).find((value) => value !== undefined && value !== null && value !== "");

/**
 * Finds the message list inside a HeyReach payload. The shape varies by endpoint, so the
 * largest array whose entries look like messages wins.
 *
 * @param {unknown} root
 * @returns {Record<string, unknown>[]}
 */
export function extractMessageRows(root) {
  /** @type {Record<string, unknown>[][]} */
  const candidates = [];
  const seen = new Set();
  /** @param {unknown} value @param {number} depth */
  const visit = (value, depth) => {
    if (!value || depth > 6 || seen.has(value)) return;
    if (typeof value === "object") seen.add(value);
    if (Array.isArray(value)) {
      const rows = value.map(object).filter((row) => Object.keys(row).length);
      const looksLikeMessages = rows.some((row) => first(row, ["message", "body", "text", "content", "messageText", "messageBody", "message_type", "messageType"]) !== undefined);
      if (looksLikeMessages) candidates.push(rows);
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value === "object") Object.values(object(value)).forEach((item) => visit(item, depth + 1));
  };
  visit(root, 0);
  return candidates.sort((a, b) => b.length - a.length)[0] ?? [];
}

/**
 * HeyReach labels every message with `sender: "ME" | "CORRESPONDENT"` and ships no message
 * id, so this exact match is the only reliable signal and has to be checked before the
 * looser heuristics below — those match on substrings and would happily read "ME" out of a
 * sender *name* like "Mehmet". Everything after it is a fallback for other payload shapes.
 *
 * @param {Record<string, unknown>} row
 * @param {string} accountId
 * @returns {"inbound" | "outbound"}
 */
export function directionFor(row, accountId) {
  const label = text(first(row, ["sender", "senderType", "authorType", "direction", "messageDirection"])).toUpperCase();
  if (label === "ME" || label === "SENDER" || label === "ACCOUNT") return "outbound";
  if (label === "CORRESPONDENT" || label === "THEM" || label === "LEAD" || label === "PARTICIPANT") return "inbound";

  if (typeof row.is_reply === "boolean") return row.is_reply ? "inbound" : "outbound";
  if (typeof row.isReply === "boolean") return row.isReply ? "inbound" : "outbound";
  for (const key of ["isFromMe", "fromMe", "sentByMe", "isSender", "isOutbound"]) {
    if (typeof row[key] === "boolean") return row[key] ? "outbound" : "inbound";
  }
  const direction = text(first(row, ["direction", "messageDirection", "senderType", "authorType", "type"])).toLowerCase();
  if (["outbound", "sent", "sender", "account"].some((part) => direction.includes(part))) return "outbound";
  if (["inbound", "received", "reply", "lead", "participant", "correspondent"].some((part) => direction.includes(part))) return "inbound";
  const sender = object(first(row, ["sender", "author", "from"]));
  const messageSenderId = text(first(row, ["senderId", "sender_id", "linkedInAccountId", "accountId"])) || text(first(sender, ["id", "accountId", "linkedInAccountId"]));
  return messageSenderId && messageSenderId === accountId ? "outbound" : "inbound";
}

/**
 * How far apart two records of the same message body may be and still be the same message.
 * Wide enough to absorb a substituted webhook event timestamp, narrow enough that a lead
 * genuinely repeating themselves later in a thread stays a separate message.
 */
export const NEAR_DUPLICATE_MS = 5 * 60_000;

/**
 * Identifies a message without its direction. HeyReach sends no message id, so a message is
 * only recognisable by when it was sent and what it said. Deliberately excluding the
 * direction means a disagreement about who sent it corrects the existing row instead of
 * inserting a second copy attributed to the other party.
 *
 * @param {unknown} sentAt
 * @param {unknown} body
 * @returns {string}
 */
export const messageKey = (sentAt, body) => {
  const parsed = new Date(text(sentAt));
  return `${Number.isNaN(parsed.getTime()) ? text(sentAt) : parsed.toISOString()}|${text(body)}`;
};

/**
 * The id stored for a message HeyReach gave no id of its own. Derived from `messageKey`, so
 * whichever process writes a message first, the others collide with it on the
 * (conversation_id, heyreach_message_id) unique index instead of inserting a second copy.
 *
 * @param {unknown} sentAt
 * @param {unknown} body
 * @returns {string}
 */
export const syntheticMessageId = (sentAt, body) =>
  `rr-${createHash("sha256").update(messageKey(sentAt, body)).digest("hex").slice(0, 32)}`;
