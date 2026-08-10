type Row = Record<string, unknown>;
type Config = { url: string; key: string };

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

/** Resolve the latest inbound message for a conversation, which is where per-reply AI state lives. */
export async function latestInboundMessage(
  { url, key }: Config,
  conversationId: string,
): Promise<{ id: string; radar: Row } | null> {
  if (!conversationId) return null;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const response = await fetch(
    `${url}/rest/v1/rr_messages?select=id,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}&direction=eq.inbound&order=sent_at.desc&limit=1`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  if (!response?.ok) return null;
  const rows = (await response.json().catch(() => [])) as Row[];
  const row = rows?.[0];
  if (!row?.id) return null;
  return { id: String(row.id), radar: object(object(row.raw_data).reply_radar) };
}

/**
 * Merge fields into a message's raw_data.reply_radar.
 *
 * Re-reads the row immediately before writing so that concurrent writers (sentiment,
 * draft, follow-up score) preserve each other's fields instead of overwriting the
 * whole jsonb blob with a stale snapshot.
 */
export async function mergeMessageRadar(
  { url, key }: Config,
  messageId: string,
  patch: Row,
): Promise<boolean> {
  if (!messageId) return false;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };

  const current = await fetch(
    `${url}/rest/v1/rr_messages?select=raw_data&id=eq.${encodeURIComponent(messageId)}&limit=1`,
    { headers, cache: "no-store" },
  ).catch(() => null);
  if (!current?.ok) return false;
  const rows = (await current.json().catch(() => [])) as Row[];
  if (!rows?.length) return false;

  const raw = object(rows[0].raw_data);
  const radar = object(raw.reply_radar);
  const response = await fetch(`${url}/rest/v1/rr_messages?id=eq.${encodeURIComponent(messageId)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ raw_data: { ...raw, reply_radar: { ...radar, ...patch } } }),
  }).catch(() => null);
  return Boolean(response?.ok);
}
