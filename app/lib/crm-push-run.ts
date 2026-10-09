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
import { attioPush } from "./attio-push";
import { sheetsPushBatch } from "./sheets-push";

/** The provider's push for one conversation. */
const pushFor = (destination: Destination) => {
  if (destination.provider === "hubspot") return hubspotPush;
  if (destination.provider === "attio") return attioPush;
  throw new Error(`${destination.provider} pushing is not built yet.`);
};

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
    if (destination.provider === "google_sheets" && (destination.config as { content?: string } | null)?.content === "meetings") { summary.nextOffset = null; break; }
    if (destination.provider === "google_sheets") {
      // A sheet takes the whole batch in one write (Google limits writes per minute, not cells).
      const due = records.filter((record) => stored.get(record.conversationId)?.pushed_hash !== record.hash);
      summary.unchanged += records.length - due.length;
      try {
        const rows = due.length ? await sheetsPushBatch(destination, due) : new Map();
        for (const record of due) {
          const placed = rows.get(record.conversationId);
          await savePushRecord(config, destination.workspace_id, destination.provider, { conversationId: record.conversationId, contactId: placed ? String(placed.row) : null, hash: record.hash, createdContact: placed?.created ?? false });
          summary.pushed += 1;
          if (placed?.created && !stored.get(record.conversationId)?.created_contact) summary.created += 1; else summary.updated += 1;
        }
      } catch (error) {
        summary.failed += due.length;
        summary.errors.push((error instanceof Error ? error.message : "failed").slice(0, 200));
        break;
      }
      offset += scanned;
      if (scanned < BATCH) { summary.nextOffset = null; break; }
      if (Date.now() - started > budget) { summary.nextOffset = offset; break; }
      continue;
    }
    for (const record of records) {
      const before = stored.get(record.conversationId);
      if (before?.pushed_hash === record.hash) { summary.unchanged += 1; continue; }
      try {
        const result = await pushFor(destination)(destination.api_key, destination, record, before);
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

/**
 * One lead, for a test before "Push all": the newest reply not pushed yet (or the newest at all when every one
 * has been), sent on its own. Returns who it was and where the contact is, so the person can check it.
 */
export async function pushOne(config: Config, destination: Destination): Promise<{ name: string; company: string; campaign: string; contactId: string; created: boolean; link: string | null }> {
  if (!destination.api_key) throw new Error("Not connected.");
  if (destination.status !== "built") throw new Error("The build has not been approved and applied yet.");
  const push = pushFor(destination);
  const { records } = await replyRecords(config, destination.workspace_id, { limit: 25 });
  if (!records.length) throw new Error("There are no replies to push yet.");
  const stored = await pushedRecords(config, destination.workspace_id, destination.provider, records.map((record) => record.conversationId));
  const record = records.find((candidate) => !stored.has(candidate.conversationId)) ?? records[0];
  const before = stored.get(record.conversationId);
  const result = await push(destination.api_key, destination, record, before);
  await savePushRecord(config, destination.workspace_id, destination.provider, { conversationId: record.conversationId, contactId: result.contactId, companyId: result.companyId, noteId: result.noteId, hash: record.hash, createdContact: result.created });
  const host = (destination.account_name ?? "").includes("hubspot.com") ? destination.account_name : "app.hubspot.com";
  return {
    name: record.name,
    company: record.company,
    campaign: record.campaign,
    contactId: result.contactId,
    created: result.created,
    link: destination.provider === "attio"
      ? `https://app.attio.com/${String((destination.config ?? {}).attio_slug ?? "")}/person/${result.contactId}/overview`
      : destination.account_id ? `https://${host}/contacts/${destination.account_id}/record/0-1/${result.contactId}` : null,
  };
}
