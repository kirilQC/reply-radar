// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * One push pass: the client's replies, a batch at a time, into their CRM. Used by the cockpit's
 * "Push all replies" (which calls again with `nextOffset` until it is null) and by the worker's automatic sync
 * (`since` = the last push, so only conversations that moved are read). A conversation whose content has not
 * changed since its last push is skipped; one that fails is recorded with its error and the pass goes on.
 */

import { pushedRecords, replyRecords, saveDestination, savePushRecord, type Config, type Destination } from "./crm-push";
import { hubspotPush } from "./hubspot-push";

export type PushSummary = { pushed: number; created: number; updated: number; unchanged: number; failed: number; errors: string[]; nextOffset: number | null; at: string };

export async function pushPass(config: Config, destination: Destination, opts: { offset?: number; since?: string; budgetMs?: number } = {}): Promise<PushSummary> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  const summary: PushSummary = { pushed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [], nextOffset: null, at: new Date().toISOString() };
  if (!destination.api_key) throw new Error("Not connected.");
  if (destination.status !== "built") throw new Error("The build has not been approved and applied yet.");
  const BATCH = 25;
  let offset = opts.offset ?? 0;
  for (;;) {
    const { records, scanned } = await replyRecords(config, destination.workspace_id, { since: opts.since, limit: BATCH, offset });
    const stored = await pushedRecords(config, destination.workspace_id, destination.provider, records.map((record) => record.conversationId));
    for (const record of records) {
      const before = stored.get(record.conversationId);
      if (before?.pushed_hash === record.hash) { summary.unchanged += 1; continue; }
      try {
        if (destination.provider !== "hubspot") throw new Error(`${destination.provider} pushing is not built yet.`);
        const result = await hubspotPush(destination.api_key, destination, record, before);
        await savePushRecord(config, destination.workspace_id, destination.provider, { conversationId: record.conversationId, contactId: result.contactId, companyId: result.companyId, noteId: result.noteId, hash: record.hash, createdContact: result.created });
        summary.pushed += 1;
        if (result.created && !before?.created_contact) summary.created += 1; else summary.updated += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "failed";
        summary.failed += 1;
        if (summary.errors.length < 5) summary.errors.push(`${record.name}: ${message.slice(0, 160)}`);
        await savePushRecord(config, destination.workspace_id, destination.provider, { conversationId: record.conversationId, contactId: before?.contact_id, companyId: before?.company_id, noteId: before?.note_id, createdContact: before?.created_contact, error: message.slice(0, 300) }).catch(() => undefined);
      }
    }
    offset += scanned;
    if (scanned < BATCH) { summary.nextOffset = null; break; }
    if (Date.now() - started > budget) { summary.nextOffset = offset; break; }
  }
  await saveDestination(config, destination.workspace_id, destination.kind, { last_push_at: summary.at, last_push_summary: summary as unknown as Record<string, unknown> }).catch(() => undefined);
  return summary;
}
