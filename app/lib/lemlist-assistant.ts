// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * QC Bot's campaign tools (heyreach_campaigns, heyreach_campaign_metrics, heyreach_senders,
 * heyreach_workspace_totals) for a client whose outreach runs on lemlist instead of HeyReach. Each answer
 * has the same shape the HeyReach version returns, plus `source: "lemlist"`, so the model reports a lemlist
 * client exactly as it reports a HeyReach one. Figures map as in lemlist-figures.ts.
 */

import { isOurCampaign } from "../../shared/campaign-code.mjs";
import { sendingDaysLeft } from "../../shared/sending-runway.mjs";
import { batchCampaignStats, listCampaigns, teamSenders, teamUsers } from "./lemlist";
import { lemlistCampaignFigures } from "./lemlist-figures";

type Row = Record<string, unknown>;
const int = (value: unknown) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const invited = (row: Row) => (Array.isArray(row.steps) ? row.steps.map(object) : []).reduce((sum, step) => sum + int(step.invited), 0);

export async function lemlistCampaignsAnswer(clientName: string, apiKey: string): Promise<Row> {
  const { campaigns } = await lemlistCampaignFigures(apiKey);
  const describe = (c: (typeof campaigns)[number]) => ({
    id: c.id,
    name: c.name,
    lemlistStatus: c.status,
    launchedAt: c.launchedAt,
    listSize: c.total,
    pendingLeads: c.pending,
    contacted: c.launched,
    senders: c.senderIds.length,
    senderNames: c.senderNames,
    daysOfSendingLeft: c.status === "IN_PROGRESS" && c.pending > 0 ? sendingDaysLeft(c.pending, c.senderIds.length) : null,
  });
  return {
    client: clientName,
    source: "lemlist",
    note: "This client's outreach runs on lemlist, not HeyReach; these are lemlist's figures for QC's campaigns. Active means running AND still contacting new leads. Worked through means running with the list exhausted.",
    active: campaigns.filter((c) => c.status === "IN_PROGRESS" && c.pending > 0).map(describe),
    workedThrough: campaigns.filter((c) => c.status === "IN_PROGRESS" && c.pending === 0).map(describe),
    scheduled: campaigns.filter((c) => c.status === "DRAFT").map(describe),
    paused: campaigns.filter((c) => c.status === "PAUSED").map(describe),
  };
}

export async function lemlistMetricsAnswer(clientName: string, apiKey: string, since: string, until: string): Promise<Row> {
  const ours = (await listCampaigns(apiKey)).filter((row) => isOurCampaign(row.name));
  const start = since || "2020-01-01T00:00:00.000Z";
  const end = until || new Date().toISOString();
  const stats = new Map<string, Row>();
  for (let i = 0; i < ours.length; i += 100) for (const row of await batchCampaignStats(apiKey, ours.slice(i, i + 100).map((c) => c.id), start, end)) stats.set(String(row.campaignId ?? ""), row);
  return {
    client: clientName,
    source: "lemlist",
    window: since ? { since, until } : "all time",
    note: "This client's outreach runs on lemlist, not HeyReach. Only campaigns QC launched. Rates are computed here from the raw counts: acceptance = accepted ÷ invites sent, reply rate = leads who replied ÷ leads reached.",
    campaigns: ours.map((campaign) => {
      const row = stats.get(campaign.id) ?? {};
      const sent = invited(row);
      return {
        id: campaign.id,
        name: campaign.name,
        connectionsSent: sent,
        connectionsAccepted: int(row.invitationAccepted),
        acceptanceRatePercent: pct(int(row.invitationAccepted), sent),
        messagesSent: int(row.messagesSent),
        leadsReached: int(row.nbLeadsReached),
        replies: int(row.replied ?? row.nbLeadsAnswered),
        leadsWhoReplied: int(row.nbLeadsAnswered),
        replyRatePercent: pct(int(row.nbLeadsAnswered), int(row.nbLeadsReached)),
        taggedInterested: int(row.nbLeadsInterested),
      };
    }),
  };
}

export async function lemlistSendersAnswer(clientName: string, apiKey: string): Promise<Row> {
  const [users, senders, campaigns] = await Promise.all([teamUsers(apiKey), teamSenders(apiKey), listCampaigns(apiKey)]);
  const ours = new Set(campaigns.filter((c) => isOurCampaign(c.name)).map((c) => c.id));
  return {
    client: clientName,
    source: "lemlist",
    note: "lemlist does not report a LinkedIn session's health through its API, so only who sends and on how many of QC's campaigns is known.",
    senders: senders.map((sender) => ({
      id: sender.userId,
      name: users.get(sender.userId) ?? "",
      campaigns: sender.campaignIds.filter((id) => ours.has(id)).length,
    })),
  };
}

export async function lemlistTotalsAnswer(clientName: string, apiKey: string, since: string, until: string): Promise<Row> {
  const all = await listCampaigns(apiKey);
  const start = since || "2020-01-01T00:00:00.000Z";
  const end = until || new Date().toISOString();
  let rows: Row[] = [];
  for (let i = 0; i < all.length; i += 100) rows = rows.concat(await batchCampaignStats(apiKey, all.slice(i, i + 100).map((c) => c.id), start, end));
  const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const sent = sum(invited);
  const accepted = sum((row) => int(row.invitationAccepted));
  const reached = sum((row) => int(row.nbLeadsReached));
  const answered = sum((row) => int(row.nbLeadsAnswered));
  return {
    client: clientName,
    source: "lemlist",
    window: since ? { since, until } : "all time",
    note: "The client's whole lemlist account, including any campaigns not launched by QC.",
    connectionsSent: sent,
    connectionsAccepted: accepted,
    acceptanceRatePercent: pct(accepted, sent),
    messagesSent: sum((row) => int(row.messagesSent)),
    replies: sum((row) => int(row.replied ?? row.nbLeadsAnswered)),
    replyRatePercent: pct(answered, reached),
    uniqueLeadsContacted: reached,
    taggedInterested: sum((row) => int(row.nbLeadsInterested)),
  };
}
