// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The figures every brief (morning, end of week, personal) carries beside the LinkedIn campaign numbers, so
 * email is reported as first-class work and not left out:
 *
 *   - Email Bison: our email campaigns' totals, and sends / replies / interested this week vs last week.
 *   - Replies by channel, from QC's own inbox (every platform): people who replied on LinkedIn and by email in
 *     the last 7 days vs the 7 before, and how many of those replies read as positive.
 *   - Meetings booked in the last 7 days vs the 7 before.
 *
 * Read from our own tables only, so it never fails a brief: anything unreadable is simply absent.
 */

import { isOurCampaign } from "./campaign-code.mjs";

const list = (value) => (Array.isArray(value) ? value : []);
const int = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0);


const DAY = 86_400_000;

/** @param {(path: string) => Promise<unknown>} read */
export async function gatherChannelFigures(read, workspaceId, now = Date.now()) {
  const ws = `workspace_id=eq.${encodeURIComponent(workspaceId)}`;
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const twoWeeksAgo = new Date(now - 14 * DAY).toISOString();
  const [campaignRows, dayRows, conversationRows, meetingRows] = await Promise.all([
    read(`rr_email_campaign_stats?select=name,status,leads_contacted,emails_sent,unique_replies,interested,bounced&${ws}&order=emails_sent.desc&limit=100`).catch(() => []),
    read(`rr_email_daily_stats?select=day,sent,replies,interested&${ws}&day=gte.${twoWeeksAgo.slice(0, 10)}&order=day.desc&limit=20`).catch(() => []),
    read(`rr_conversations?select=id,channel,heyreach_conversation_id&${ws}&last_message_at=gte.${encodeURIComponent(twoWeeksAgo)}&limit=2000`).catch(() => []),
    read(`rr_meetings?select=created_at&${ws}&created_at=gte.${encodeURIComponent(twoWeeksAgo)}&limit=500`).catch(() => []),
  ]);

  // Email Bison. Workspace-wide daily figures are as Bison charts them; campaigns are narrowed to ours.
  const campaigns = list(campaignRows).filter((row) => isOurCampaign(String(row.name ?? "")));
  const days = list(dayRows);
  const sumDays = (from, to) => days
    .filter((row) => String(row.day) >= from.slice(0, 10) && String(row.day) < to.slice(0, 10))
    .reduce((acc, row) => ({ sent: acc.sent + int(row.sent), replies: acc.replies + int(row.replies), interested: acc.interested + int(row.interested) }), { sent: 0, replies: 0, interested: 0 });
  const tomorrow = new Date(now + DAY).toISOString();
  const email = campaigns.length || days.length
    ? {
        campaigns: campaigns.map((row) => ({ name: String(row.name ?? ""), status: String(row.status ?? ""), contacted: int(row.leads_contacted), sent: int(row.emails_sent), replies: int(row.unique_replies), interested: int(row.interested), bounced: int(row.bounced) })),
        recent: sumDays(weekAgo, tomorrow),
        prior: sumDays(twoWeeksAgo, weekAgo),
      }
    : null;

  // Replies by channel, counted as people (conversations) whose reply landed in each window.
  const conversations = list(conversationRows);
  const channelOf = new Map(conversations.map((row) => [String(row.id), String(row.channel ?? "") === "email" || String(row.heyreach_conversation_id ?? "").startsWith("bison:") ? "email" : "linkedin"]));
  const empty = () => ({ linkedin: 0, email: 0, positive: 0 });
  const replies = { recent: empty(), prior: empty() };
  const ids = [...channelOf.keys()];
  const inbound = [];
  for (let i = 0; i < ids.length; i += 80) {
    inbound.push(...list(await read(`rr_messages?select=conversation_id,sent_at,sentiment:raw_data->reply_radar->>sentiment&conversation_id=in.(${ids.slice(i, i + 80).join(",")})&direction=eq.inbound&sent_at=gte.${encodeURIComponent(twoWeeksAgo)}&limit=5000`).catch(() => [])));
  }
  const seen = { recent: new Map(), prior: new Map() };
  for (const row of inbound) {
    const bucket = String(row.sent_at) >= weekAgo ? "recent" : "prior";
    const id = String(row.conversation_id);
    seen[bucket].set(id, (seen[bucket].get(id) ?? false) || String(row.sentiment ?? "") === "positive");
  }
  for (const bucket of ["recent", "prior"]) {
    for (const [id, positive] of seen[bucket]) {
      replies[bucket][channelOf.get(id) === "email" ? "email" : "linkedin"] += 1;
      if (positive) replies[bucket].positive += 1;
    }
  }

  const meetings = list(meetingRows);
  return {
    email,
    replies,
    meetings: { recent: meetings.filter((row) => String(row.created_at) >= weekAgo).length, prior: meetings.filter((row) => String(row.created_at) < weekAgo).length },
  };
}

/** The figures as the brief's model reads them: facts, one per line, with last week beside this week. */
export function channelFiguresAsText(figures) {
  if (!figures) return "";
  const lines = ["", "## Replies and meetings across every channel (QC's own inbox: LinkedIn and email, all platforms)"];
  const { replies, meetings, email } = figures;
  lines.push(`People who replied in the last 7 days: ${replies.recent.linkedin} on LinkedIn, ${replies.recent.email} by email (the 7 days before: ${replies.prior.linkedin} on LinkedIn, ${replies.prior.email} by email).`);
  lines.push(`Of those, read as positive: ${replies.recent.positive} (the 7 days before: ${replies.prior.positive}).`);
  lines.push(`Meetings booked in the last 7 days: ${meetings.recent} (the 7 days before: ${meetings.prior}).`);
  if (email) {
    lines.push("", "## Email campaigns (Email Bison and lemlist email)");
    lines.push(`Emails sent in the last 7 days: ${email.recent.sent} (the 7 days before: ${email.prior.sent}). Email replies: ${email.recent.replies} (before: ${email.prior.replies}). Marked interested: ${email.recent.interested} (before: ${email.prior.interested}).`);
    for (const campaign of email.campaigns.slice(0, 15)) {
      const rate = campaign.contacted ? ` (${Math.round((campaign.replies / campaign.contacted) * 1000) / 10}% of leads contacted replied)` : "";
      lines.push(`- ${campaign.name} [${campaign.status || "unknown"}]: ${campaign.contacted} leads contacted, ${campaign.sent} emails sent, ${campaign.replies} replied${rate}, ${campaign.interested} interested, ${campaign.bounced} bounced.`);
    }
    lines.push("Report email campaigns alongside the LinkedIn ones, under the same headings. Email has no connection requests, so it never counts toward the LinkedIn runway or acceptance rate.");
  }
  return lines.join("\n");
}

