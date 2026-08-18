// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The step that makes the trackers keep themselves.
 *
 * ── What this is for ──────────────────────────────────────────────────────────────────────────────
 * Both tables are read in Airtable's gallery view as a live answer to "what is outstanding today". A
 * table that only ever gains rows stops answering that within a fortnight, which is what happened to
 * the tracker this replaced: five rows, three of them finished months ago, so nobody opened it. So the
 * sync closes as much as it opens, and the closing half is the part that matters.
 *
 * ── The two tables are governed differently, on purpose ───────────────────────────────────────────
 * A campaign row is a permanent record. It gains a status and a set of final figures and then stays,
 * because "what did BV003 actually do" is a question somebody asks six months later. Nothing here ever
 * deletes one.
 *
 * A project row is a note about something unfinished. Once it is finished the note has no value — the
 * work is in the campaign figures, and what was said about it is in `rr_slack_briefs` forever. So
 * these are deleted, and the user asked for exactly that: "delete or archive them, so the view doesn't
 * get flooded". Archiving was the other option and it is worse here, because Airtable has no archive:
 * it would mean a checkbox plus a filtered view per client, and a filter somebody has to remember to
 * apply is a filter that will be missing in one base and the flooding comes back there.
 *
 * ── The ownership boundary ────────────────────────────────────────────────────────────────────────
 * Deleting rows is only safe because the brief can prove which rows are its own. `Raised by Brief` is
 * ticked on creation and checked before every update and every delete. A row somebody typed by hand is
 * never edited and never removed, however stale it looks, and unticking the box on a brief-raised row
 * takes it out of the brief's reach permanently. Without that boundary this file would be a scheduled
 * job that deletes a colleague's notes.
 *
 * ── Why a missing item is not deleted immediately ─────────────────────────────────────────────────
 * The brief leaves finished work out entirely, so "gone from the brief" usually means "done". Usually.
 * It can also mean the model had a thin morning, or a Slack read failed and the evidence for an item
 * was not in front of it. Deleting on the first absence makes one bad run destructive. `STALE_DAYS`
 * below is the wait, and it is set against the schedule rather than picked: briefs run three mornings a
 * week, so five days is at least two runs that did not mention the item. An item somebody explicitly
 * marks Done goes immediately, because that is a person saying so rather than an absence being read.
 *
 * ── Why the writing is not in here ────────────────────────────────────────────────────────────────
 * Everything below decides what should happen and nothing below does it, so the rules that delete a
 * client's rows can be tested against fixtures rather than against Airtable. `syncTrackers` in
 * `tracker-sync-run.ts` is the half that opens sockets.
 */
import type { AirtableRecord } from "./airtable";
import type { BriefCampaign } from "./morning-brief";
import type { TrackerItem } from "./tracker-extract";

/** See the note at the top of the file. Two missed briefs, not a round number. */
export const STALE_DAYS = 5;

/**
 * The lifecycle the brief drives a campaign through, and every name a client base might already use
 * for each state.
 *
 * Written as intents rather than literal option names because the `Status` choice sets have drifted
 * per client and cannot be corrected from here — Airtable's API will not remove a select option, and
 * rewriting somebody's choice set to suit us would relabel rows they are reading. So each state is
 * resolved against whatever the base actually has, first synonym wins, and when none of them are there
 * the status is left alone and the reason is reported. Never `typecast`, which would quietly invent the
 * option and leave a client with two words for the same thing.
 *
 * `sentForApproval` is listed although the brief never writes it: the approval process does, and the
 * brief has to recognise it to know a row is waiting rather than dormant.
 */
export const CAMPAIGN_STATE_SYNONYMS: Record<"sentForApproval" | "active" | "paused" | "finished", string[]> = {
  sentForApproval: ["Sent for Approval", "Awaiting Approval", "Pending Approval", "For Approval", "In Review", "Not Started"],
  active: ["Active", "Launched", "Live", "Running", "In Progress"],
  paused: ["Paused", "On Hold", "Held"],
  finished: ["Finished", "Completed", "Complete", "Done", "Ended"],
};

export type CampaignState = "active" | "paused" | "finished";

export type TrackerSyncResult = {
  ran: boolean;
  campaigns: { created: number; updated: number; finished: string[] };
  projects: { created: number; updated: number; removed: number };
  notes: string[];
};

const flat = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The option this base actually uses for one lifecycle state, or null if it has no word for it.
 *
 * Null is a real answer and the caller must respect it. The alternative is `typecast`, which would add
 * the option to the client's field on our say-so, and a base that has been running for months with
 * `Launched` does not need a second option called `Active` appearing next to it.
 */
export function resolveChoice(choices: string[], wanted: string[]): string | null {
  const have = new Map(choices.map((choice) => [flat(choice), choice]));
  for (const want of wanted) {
    const match = have.get(flat(want));
    if (match) return match;
  }
  return null;
}

/**
 * The code at the front of a campaign name: `BV007: ASCs v2` is `BV007`.
 *
 * This is the join between a tracker row and the lead table it came from, and it is taken from the
 * name rather than stored anywhere because the name is what HeyReach gives us and the codes are the
 * agency's own convention. A campaign named without one gets an empty code and is matched on its title
 * instead, which is weaker but is what there is.
 */
export function campaignCode(name: string): string {
  const match = /^\s*([A-Za-z]{2,4}\s?\d{2,4})\b/.exec(String(name ?? ""));
  return match ? match[1].replace(/\s+/g, "").toUpperCase() : "";
}

/**
 * Where one campaign is in its life, or null when the figures do not say.
 *
 * Finished is checked first and deliberately does not require HeyReach to agree. A campaign that has
 * sent to everybody on its list sits at `IN_PROGRESS` in HeyReach indefinitely — nothing switches it
 * off — so waiting for HeyReach's word would mean no campaign is ever marked finished. Out of leads
 * having sent some is the real end of a campaign, and it is the transition the user described.
 *
 * Null matters as much as the three states. A campaign with no leads sent and none pending has not
 * started; saying "active" about it would put a row on the board that nobody is working on.
 */
export function campaignState(campaign: BriefCampaign): CampaignState | null {
  const status = String(campaign.status ?? "");
  if (/finish|complet|done|ended/i.test(status)) return "finished";
  if (campaign.pending === 0 && campaign.sent > 0) return "finished";
  if (campaign.isActive) return "active";
  if (/pause|stopped|hold/i.test(status)) return "paused";
  return null;
}

export type CampaignPlan = {
  creates: Record<string, unknown>[];
  updates: { id: string; fields: Record<string, unknown> }[];
  finished: string[];
  notes: string[];
};

/**
 * What to write to the campaign table, worked out without touching the network so it can be tested.
 *
 * Only the columns the brief owns are ever in a payload. `Title` is written on creation and never
 * again, `Owner` and `Notes` never at all — those are somebody's writing, and a sync that refreshes
 * them is a sync that erases a note explaining why a campaign is paused.
 */
export function planCampaigns(campaigns: BriefCampaign[], rows: AirtableRecord[], statusChoices: string[], today: string): CampaignPlan {
  const plan: CampaignPlan = { creates: [], updates: [], finished: [], notes: [] };
  const option = (state: CampaignState) => resolveChoice(statusChoices, CAMPAIGN_STATE_SYNONYMS[state]);
  const missing = new Set<string>();

  const byCode = new Map<string, AirtableRecord>();
  const byTitle = new Map<string, AirtableRecord>();
  for (const row of rows) {
    const code = String(row.fields["Campaign Code"] ?? "").trim().toUpperCase();
    if (code && !byCode.has(code)) byCode.set(code, row);
    const title = flat(row.fields.Title);
    if (title && !byTitle.has(title)) byTitle.set(title, row);
  }

  for (const campaign of campaigns) {
    const code = campaignCode(campaign.name);
    const existing = (code ? byCode.get(code) : null) ?? byTitle.get(flat(campaign.name)) ?? null;
    const state = campaignState(campaign);

    // Figures first, and the same on a create as on an update. `Senders` is names only and is left
    // blank rather than filled with a count or an id, which is the rule the whole brief runs on.
    const figures: Record<string, unknown> = {
      "Leads Sent": campaign.sent,
      Accepted: campaign.accepted,
      Replies: campaign.replies,
      "Pending Leads": campaign.pending,
      "Days Left": campaign.daysLeft,
      Senders: campaign.senders.join(", "),
      "Last Synced": today,
    };

    const choice = state ? option(state) : null;
    if (state && !choice) missing.add(state);
    if (choice) figures.Status = choice;

    if (!existing) {
      plan.creates.push({ Title: campaign.name, "Campaign Code": code, ...figures, ...(state === "finished" ? { "Finished On": today } : {}) });
      if (state === "finished") plan.finished.push(campaign.name);
      continue;
    }

    const wasFinished = Boolean(existing.fields["Finished On"]);
    if (state === "finished" && !wasFinished) {
      figures["Finished On"] = today;
      plan.finished.push(campaign.name);
    }
    // Leads added to a campaign that had run dry reopen it. Clearing the date as well as the status
    // matters: a row reading Active with a finish date on it is a row nobody can interpret.
    if (state === "active" && wasFinished) figures["Finished On"] = null;

    plan.updates.push({ id: existing.id, fields: figures });
  }

  for (const state of missing) {
    plan.notes.push(`This base has no Status option meaning "${state}", so those rows kept the status they had. Add one of: ${CAMPAIGN_STATE_SYNONYMS[state as CampaignState].join(", ")}.`);
  }
  return plan;
}

export type ProjectPlan = {
  creates: Record<string, unknown>[];
  updates: { id: string; fields: Record<string, unknown> }[];
  deletes: string[];
  notes: string[];
};

/**
 * An older key was `client:2026-08-18:surgeon-offices`, which carried the date of the brief that
 * raised it and so never matched the next brief's key for the same item. Reading only the last segment
 * makes those rows findable again, so the first run after this change updates them instead of leaving
 * seven orphans behind to be swept.
 */
export function normaliseKey(value: unknown): string {
  const parts = String(value ?? "").trim().toLowerCase().split(":");
  return (parts[parts.length - 1] ?? "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Whole days between two `YYYY-MM-DD` dates, or null if either is not one. */
export function daysBetween(from: unknown, to: string): number | null {
  const start = Date.parse(`${String(from ?? "").slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/**
 * What to write to the project table: the items the brief raised, and the rows it should now let go of.
 *
 * `campaignIds` is how an item gets linked to the campaign it concerns. A code with no row behind it
 * links to nothing rather than creating one — the campaign table is fed from HeyReach, and a campaign
 * invented here from a mention in a brief would be a campaign that does not exist.
 */
export function planProjects(
  items: TrackerItem[],
  rows: AirtableRecord[],
  choices: { status: string[]; type: string[]; source: string[] },
  campaignIds: Map<string, string>,
  today: string,
  staleDays = STALE_DAYS,
): ProjectPlan {
  const plan: ProjectPlan = { creates: [], updates: [], deletes: [], notes: [] };
  const ours = (row: AirtableRecord) => row.fields["Raised by Brief"] === true;
  const existing = new Map<string, AirtableRecord>();
  for (const row of rows) {
    const key = normaliseKey(row.fields["Brief Key"]);
    if (key && ours(row) && !existing.has(key)) existing.set(key, row);
  }

  const seen = new Set<string>();
  for (const item of items) {
    seen.add(item.key);
    const linked = campaignIds.get(item.campaignCode);
    const fields: Record<string, unknown> = {
      Title: item.title,
      Detail: item.detail,
      Owner: item.owner,
      "Brief Key": item.key,
      "Last Seen": today,
      ...(resolveChoice(choices.type, [item.type]) ? { Type: item.type } : {}),
      ...(resolveChoice(choices.status, [item.status]) ? { Status: item.status } : {}),
      ...(resolveChoice(choices.source, [item.source]) ? { Source: item.source } : {}),
      ...(linked ? { Campaign: [linked] } : {}),
    };
    const row = existing.get(item.key);
    if (row) plan.updates.push({ id: row.id, fields });
    else plan.creates.push({ ...fields, "First Raised": today, "Raised by Brief": true });
  }

  for (const row of rows) {
    if (!ours(row)) continue;
    const key = normaliseKey(row.fields["Brief Key"]);
    if (key && seen.has(key)) continue;
    // A person saying it is done outranks the wait. The wait exists for silence, not for a decision.
    const closed = /^(done|complete|completed|cancelled|canceled)$/i.test(String((row.fields.Status as { name?: string })?.name ?? row.fields.Status ?? ""));
    const age = daysBetween(row.fields["Last Seen"] ?? row.fields["First Raised"], today);
    if (closed || (age !== null && age >= staleDays)) plan.deletes.push(row.id);
  }

  if (plan.deletes.length) plan.notes.push(`${plan.deletes.length} item${plan.deletes.length === 1 ? "" : "s"} the brief raised stopped appearing in it and ${plan.deletes.length === 1 ? "was" : "were"} removed.`);
  return plan;
}

