export type JsonObject = Record<string, unknown>;

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown) => Array.isArray(value) ? value : [];

export function isAiArkEnrichmentEnabled(value = process.env.AI_ARK_ENRICHMENT_ENABLED) {
  return ["1", "true", "yes", "on"].includes(text(value).toLowerCase());
}

export function mergeLeadAttributions(existing: unknown, next: JsonObject) {
  const key = (value: JsonObject) => [value.workspaceId, value.conversationId, value.campaignId, value.senderId].map((part) => text(part)).join("|");
  const rows = list(existing).map(object).filter((row) => Object.keys(row).length);
  const nextKey = key(next);
  return [...rows.filter((row) => key(row) !== nextKey), next];
}
