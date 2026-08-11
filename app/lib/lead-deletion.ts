/**
 * Deleting a lead has to leave nothing behind, and has to fail loudly when it cannot.
 *
 * The previous delete fired four requests and returned success without reading a single response, so
 * a row blocked by a foreign key or a missing cascade was reported as deleted and stayed in the
 * inbox. Every delete here is checked, counted, and then verified by reading the tables back.
 */
import { queryByIds } from "./chunk-query";

type Row = Record<string, unknown>;

const auth = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}` });

export async function selectRows(url: string, key: string, path: string): Promise<Row[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: auth(key), cache: "no-store" });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`Supabase ${response.status} on ${path}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data as Row[]) : [];
}

/**
 * Deletes matching rows and returns how many were actually removed.
 *
 * `return=representation` is what makes the count real: PostgREST hands back the deleted rows, so a
 * filter that matched nothing is distinguishable from one that matched and worked.
 *
 * `tolerateMissingTable` covers `rr_scores`, which the checked-in schema declares but which may not
 * exist in a given database. A table that isn't there holds no rows to orphan, so a 404 is a
 * legitimate no-op — any other failure still throws.
 */
async function deleteRows(
  url: string,
  key: string,
  path: string,
  { tolerateMissingTable = false }: { tolerateMissingTable?: boolean } = {},
): Promise<number> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { ...auth(key), "content-type": "application/json", Prefer: "return=representation" },
    cache: "no-store",
  });
  if (response.status === 404 && tolerateMissingTable) return 0;
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`Supabase ${response.status} deleting ${path}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? data.length : 0;
}

const inList = (ids: string[]) => `in.(${ids.map(encodeURIComponent).join(",")})`;

export type DeletionCounts = { leads: number; conversations: number; messages: number; scores: number };

const emptyCounts = (): DeletionCounts => ({ leads: 0, conversations: 0, messages: 0, scores: 0 });

/**
 * Removes conversations and everything hanging off them, children first.
 *
 * Children are deleted explicitly rather than left to `on delete cascade`, because the cascade is a
 * property of whichever migration actually ran and is not something this code can see.
 */
export async function deleteConversationsCompletely(
  url: string,
  key: string,
  conversationIds: string[],
): Promise<DeletionCounts> {
  const counts = emptyCounts();
  if (!conversationIds.length) return counts;
  const ids = [...new Set(conversationIds.filter(Boolean))];
  const tally = async (run: (batch: string[]) => Promise<number>) => {
    const results = await queryByIds(ids, 20, async (batch) => [await run(batch)]);
    return results.reduce((total, value) => total + value, 0);
  };
  counts.messages = await tally((batch) => deleteRows(url, key, `rr_messages?conversation_id=${inList(batch)}`));
  counts.scores = await tally((batch) =>
    deleteRows(url, key, `rr_scores?conversation_id=${inList(batch)}`, { tolerateMissingTable: true }),
  );
  counts.conversations = await tally((batch) => deleteRows(url, key, `rr_conversations?id=${inList(batch)}`));
  return counts;
}

/**
 * Removes lead rows along with their conversations, messages and scores, then reads the tables back
 * to prove it. Verification is the point: a delete that silently matched nothing used to look
 * identical to one that worked, and the leftover row kept showing up in the inbox.
 */
export async function deleteLeadsCompletely(url: string, key: string, leadIds: string[]): Promise<DeletionCounts> {
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (!ids.length) return emptyCounts();
  const conversations = await queryByIds(ids, 40, (batch) =>
    selectRows(url, key, `rr_conversations?select=id&lead_id=${inList(batch)}`),
  );
  const counts = await deleteConversationsCompletely(url, key, conversations.map((row) => String(row.id)));
  counts.leads = (
    await queryByIds(ids, 40, async (batch) => [await deleteRows(url, key, `rr_leads?id=${inList(batch)}`)])
  ).reduce((total, value) => total + value, 0);

  const [remainingLeads, remainingConversations] = await Promise.all([
    queryByIds(ids, 40, (batch) => selectRows(url, key, `rr_leads?select=id&id=${inList(batch)}`)),
    queryByIds(ids, 40, (batch) => selectRows(url, key, `rr_conversations?select=id&lead_id=${inList(batch)}`)),
  ]);
  if (remainingLeads.length || remainingConversations.length) {
    throw new Error(
      `Delete did not finish: ${remainingLeads.length} lead row(s) and ${remainingConversations.length} conversation(s) are still present.`,
    );
  }
  return counts;
}

/**
 * Every lead row for the same person, found by LinkedIn profile URL.
 *
 * The lead drawer shows one merged person built from all of these rows, so deleting only the row
 * that happened to be clicked left the same person on screen elsewhere — which is exactly the
 * "deleted them but they're still in the inbox" report. A lead with no profile URL cannot be matched
 * to anyone, so it stands alone.
 */
export async function relatedLeadIds(url: string, key: string, leadId: string): Promise<string[]> {
  const [lead] = await selectRows(url, key, `rr_leads?select=id,linkedin_profile_url&id=eq.${encodeURIComponent(leadId)}&limit=1`);
  if (!lead) return [];
  const profileUrl = String(lead.linkedin_profile_url ?? "").trim();
  if (!profileUrl) return [String(lead.id)];
  const related = await selectRows(
    url,
    key,
    `rr_leads?select=id&linkedin_profile_url=eq.${encodeURIComponent(profileUrl)}`,
  );
  const ids = new Set(related.map((row) => String(row.id)));
  ids.add(String(lead.id));
  return [...ids];
}
