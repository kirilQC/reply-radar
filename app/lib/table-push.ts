// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { saveDestination, type Config, type Destination } from "./crm-push";
import { campaignItems, contentOf, meetingItems, writeRows, type CampaignState, type SheetConfig, type SheetContent, type TableItem } from "./sheets-push";
import { airtableWriteRows, type AirtableConfig } from "./airtable-push";

/**
 * Table destinations (Google Sheets and Airtable): what a table holds (replies, booked meetings or campaigns)
 * and one writer for both, so every content works the same in either.
 */

export const isTable = (destination: Destination) => destination.provider === "google_sheets" || destination.provider === "airtable";
export const tableContent = (destination: Destination): SheetContent => contentOf(((destination.config ?? {}) as { content?: unknown }).content);

/** Rows into the destination's table, found again by QC ID. */
export async function writeTable(destination: Destination, items: TableItem[]): Promise<Map<string, { row: string | number; created: boolean }>> {
  if (destination.provider === "airtable") return airtableWriteRows(destination.config as unknown as AirtableConfig, items);
  return writeRows(destination.config as unknown as SheetConfig, items);
}

/**
 * Booked meetings or campaigns into a table (replies go through the regular push pass). `since` limits
 * meetings to those that changed; campaigns follow their own rule (new launch, status change, weekly), and
 * `all` (Push all) writes every one now.
 */
export async function tableItemsPass(config: Config, destination: Destination, opts: { since?: string; all?: boolean } = {}): Promise<{ pushed: number; created: number; updated: number }> {
  const content = tableContent(destination);
  if (content === "replies") return { pushed: 0, created: 0, updated: 0 };
  let items: TableItem[];
  let state: CampaignState | null = null;
  if (content === "meetings") {
    items = await meetingItems(config, destination.workspace_id, { since: opts.all ? undefined : opts.since });
  } else {
    const previous = (((destination.config ?? {}) as { campaign_state?: CampaignState }).campaign_state ?? {}) as CampaignState;
    const due = await campaignItems(config, destination.workspace_id, previous, { all: opts.all });
    items = due.items;
    state = due.state;
  }
  if (!items.length) return { pushed: 0, created: 0, updated: 0 };
  const written = await writeTable(destination, items);
  // The tracker remembers when each campaign was last written, so the weekly refresh knows what is due.
  if (state) await saveDestination(config, destination.workspace_id, destination.kind, { config: { ...((destination.config ?? {}) as Record<string, unknown>), campaign_state: state } });
  const created = [...written.values()].filter((entry) => entry.created).length;
  return { pushed: written.size, created, updated: written.size - created };
}
