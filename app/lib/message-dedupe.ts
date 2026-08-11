/**
 * Collapses the duplicate message rows an earlier release could write.
 *
 * That release sometimes stored one message twice under opposite directions, which made a message we
 * sent look like the lead's. Anything deciding who spoke first has to see the collapsed thread, or a
 * duplicated outbound greeting reads as the lead opening the conversation.
 *
 * Matching allows a small timestamp drift because the duplicate was sometimes stamped with the
 * webhook event time rather than the message time.
 */
import { NEAR_DUPLICATE_MS } from "./heyreach-conversation";

type Row = Record<string, unknown>;

const radarOf = (raw: unknown): Row => {
  if (!raw || typeof raw !== "object") return {};
  const rr = (raw as Row).reply_radar;
  return rr && typeof rr === "object" ? (rr as Row) : {};
};
const isRefresh = (raw: unknown) => radarOf(raw).source === "refresh";
const hasAiState = (raw: unknown) => {
  const radar = radarOf(raw);
  return ["sentiment", "cached_draft", "followup_urgency", "analyzed_at"].some((field) => radar[field] != null);
};

export function dedupeMessages<T extends Row>(messages: T[]): T[] {
  const deduped: T[] = [];
  const byBody = new Map<string, number[]>();
  for (const message of messages) {
    const bodyKey = `${message.conversation_id}|${String(message.body).trim()}`;
    const sentAt = new Date(String(message.sent_at)).getTime();
    const candidates = byBody.get(bodyKey) ?? [];
    const twin = candidates.find(
      (position) => Math.abs(new Date(String(deduped[position].sent_at)).getTime() - sentAt) < NEAR_DUPLICATE_MS,
    );
    if (twin !== undefined) {
      // Prefer the copy carrying AI state, then the one the refresh endpoint did not invent.
      const incumbent = deduped[twin];
      const preferIncoming = hasAiState(message.raw_data)
        ? !hasAiState(incumbent.raw_data)
        : !hasAiState(incumbent.raw_data) && isRefresh(incumbent.raw_data) && !isRefresh(message.raw_data);
      if (preferIncoming) deduped[twin] = message;
      continue;
    }
    byBody.set(bodyKey, [...candidates, deduped.length]);
    deduped.push(message);
  }
  return deduped;
}
