// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Inbox tags: a small shared vocabulary the team hangs on conversations to clear up the queue (DQ,
 * Scheduling, discuss). Two halves, stored differently on purpose.
 *
 * ── Definitions live in rr_app_config ───────────────────────────────────────────────────────────────
 * The list of tags (id, name, colour) is tiny and team-wide, so it is one `inbox_tags` row in the shared
 * key/value store rather than its own table — the same call the scoring templates make. One global list,
 * so a tag somebody made is a tag everybody has.
 *
 * ── Assignments are a real table ────────────────────────────────────────────────────────────────────
 * Which conversation carries which tag grows with the inbox and must be shared — a reply marked DQ is DQ
 * for the whole team, not just the browser that marked it (which is exactly why this does NOT ride in the
 * per-device preferences that back starring). So it is `rr_inbox_tag_assignments`, keyed at conversation
 * grain to match the id the inbox already selects on. See supabase/migrations/20261001_rr_inbox_tags.sql.
 */

import { readConfig, writeConfig } from "./app-config";

export type InboxTag = { id: string; name: string; color: string };

const TAGS_KEY = "inbox_tags";
const ASSIGN_TABLE = "rr_inbox_tag_assignments";

/** A palette tag creation picks from, so colours stay legible on the dark queue and read as a set. */
export const TAG_COLORS = ["#ed6a6a", "#e7b96e", "#55c7a2", "#5aa9f0", "#8b7cff", "#d08bd0", "#9aa0ad"];

export const INBOX_TAGS_MIGRATION = "supabase/migrations/20261001_rr_inbox_tags.sql";

function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function rest(path: string, init?: RequestInit): Promise<Response> {
  const { url, key } = credentials();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supabase ${ASSIGN_TABLE} ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response;
}

const clampColor = (value: unknown): string => {
  const hex = String(value ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : TAG_COLORS[4];
};

/** The tag list, cleaned: ids and names present, colours valid, names trimmed to a chip-sized length. */
export async function readTags(): Promise<InboxTag[]> {
  const raw = await readConfig(TAGS_KEY).catch(() => undefined);
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw || "[]") : [];
  return (Array.isArray(list) ? list : [])
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => entry && entry.id && entry.name)
    .map((entry) => ({ id: String(entry.id), name: String(entry.name).slice(0, 40), color: clampColor(entry.color) }));
}

async function writeTags(tags: InboxTag[]): Promise<void> {
  await writeConfig(TAGS_KEY, tags);
}

/** A short, collision-resistant id for a new tag. Prefixed so it never looks like a uuid or a name. */
const newTagId = () => `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function createTag(name: string, color: string): Promise<InboxTag> {
  const clean = name.trim().slice(0, 40);
  if (!clean) throw new Error("A tag needs a name.");
  const tags = await readTags();
  // Reuse an existing tag of the same name rather than making a second one that looks identical.
  const existing = tags.find((tag) => tag.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const tag: InboxTag = { id: newTagId(), name: clean, color: clampColor(color) };
  await writeTags([...tags, tag]);
  return tag;
}

export async function updateTag(id: string, fields: { name?: string; color?: string }): Promise<InboxTag[]> {
  const tags = await readTags();
  const next = tags.map((tag) =>
    tag.id === id
      ? { ...tag, ...(fields.name !== undefined ? { name: fields.name.trim().slice(0, 40) || tag.name } : {}), ...(fields.color !== undefined ? { color: clampColor(fields.color) } : {}) }
      : tag,
  );
  await writeTags(next);
  return next;
}

/** Removes a tag from the vocabulary AND every conversation it was on, so nothing points at a dead id. */
export async function deleteTag(id: string): Promise<InboxTag[]> {
  const tags = await readTags();
  const next = tags.filter((tag) => tag.id !== id);
  await writeTags(next);
  await rest(`${ASSIGN_TABLE}?tag_id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => undefined);
  return next;
}

/** Tag ids per conversation, for the conversations the inbox is about to return. Batched like the rest. */
export async function assignmentsFor(conversationIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = [...new Set(conversationIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const response = await rest(`${ASSIGN_TABLE}?select=conversation_id,tag_id&conversation_id=in.(${batch.map(encodeURIComponent).join(",")})`);
    const rows = (await response.json().catch(() => [])) as { conversation_id?: unknown; tag_id?: unknown }[];
    for (const row of rows) {
      const conversation = String(row.conversation_id ?? "");
      const tag = String(row.tag_id ?? "");
      if (!conversation || !tag) continue;
      if (!map.has(conversation)) map.set(conversation, []);
      map.get(conversation)!.push(tag);
    }
  }
  return map;
}

export async function assignTag(conversationId: string, tagId: string): Promise<void> {
  // The assignment row carries workspace_id so tags are attributable per client, but the client only knows
  // the conversation it is tagging — the workspace is read from the conversation here rather than trusted
  // from the request, so a tag can never be filed under the wrong client.
  const lookup = await rest(`rr_conversations?select=workspace_id&id=eq.${encodeURIComponent(conversationId)}&limit=1`);
  const rows = (await lookup.json().catch(() => [])) as { workspace_id?: unknown }[];
  const workspaceId = String(rows[0]?.workspace_id ?? "");
  if (!workspaceId) throw new Error("That conversation no longer exists.");
  // Upsert: the unique(conversation_id, tag_id) constraint makes re-tagging a no-op rather than a duplicate.
  await rest(ASSIGN_TABLE, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ conversation_id: conversationId, workspace_id: workspaceId, tag_id: tagId }),
  });
}

export async function unassignTag(conversationId: string, tagId: string): Promise<void> {
  await rest(`${ASSIGN_TABLE}?conversation_id=eq.${encodeURIComponent(conversationId)}&tag_id=eq.${encodeURIComponent(tagId)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}
