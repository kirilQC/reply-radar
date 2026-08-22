// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Reports Hub data endpoint.
 *
 * The Reports page asks for one client (or "all") over a period and gets back every section it
 * might want to render, computed on demand. Nothing is cached — the point of hitting Generate is
 * that the numbers are as of *now*. Sections are all returned together because the cost is
 * dominated by the message scan, and computing one section vs. ten from the same scan is nearly
 * free. The UI decides which to show.
 */
import { NextResponse } from "next/server";
import { queryByIds } from "../../../lib/chunk-query";
import {
  allCampaigns,
  campaignStatusFor,
  emptyStatus,
  selectCampaigns,
  stateByName,
  type CampaignStatus,
} from "../../../lib/heyreach-campaigns";
import {
  campaignFunnelFor,
  emptyFunnel,
  reportMetrics,
  type CampaignFunnel,
} from "../../../lib/heyreach-campaign-metrics";
import { dedupeMessages } from "../../../lib/message-dedupe";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const radarOf = (raw: unknown) => object(object(raw).reply_radar);

async function query(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase ${response.status} on ${path}`);
  return (await response.json()) as Row[];
}

type Period = "daily" | "weekly" | "monthly" | "quarterly" | "all-time" | "custom";

function periodRange(period: Period, timeZone: string, custom?: { since?: string; until?: string }) {
  const now = new Date();
  if (period === "custom") {
    return {
      since: custom?.since ? new Date(custom.since).toISOString() : null,
      until: custom?.until ? new Date(custom.until).toISOString() : null,
      label: "Custom range",
    };
  }
  if (period === "all-time") return { since: null, until: null, label: "All time" };
  const start = new Date(now);
  if (period === "daily") {
    start.setUTCHours(0, 0, 0, 0);
    return { since: start.toISOString(), until: null, label: formatDay(start, timeZone) };
  }
  if (period === "weekly") {
    const day = start.getUTCDay(); // 0=Sun
    const daysBack = (day + 6) % 7; // Monday start
    start.setUTCDate(start.getUTCDate() - daysBack);
    start.setUTCHours(0, 0, 0, 0);
    return { since: start.toISOString(), until: null, label: `Week of ${formatDay(start, timeZone)}` };
  }
  if (period === "monthly") {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return {
      since: start.toISOString(),
      until: null,
      label: new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone }).format(start),
    };
  }
  // quarterly
  const month = start.getUTCMonth();
  const qStart = month - (month % 3);
  start.setUTCMonth(qStart, 1);
  start.setUTCHours(0, 0, 0, 0);
  const quarter = Math.floor(qStart / 3) + 1;
  return { since: start.toISOString(), until: null, label: `Q${quarter} ${start.getUTCFullYear()}` };
}

function formatDay(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(date);
}

function bucketIcp(score: number): "excellent" | "strong" | "moderate" | "weak" {
  if (score >= 75) return "excellent";
  if (score >= 50) return "strong";
  if (score >= 25) return "moderate";
  return "weak";
}

// Report generation is a multi-step AI job; Vercel Pro allows up to 300s, so let it run rather than die at the default.
export const maxDuration = 300;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as Json;
  const workspaceSlug = text(body.workspaceSlug);
  const period = (text(body.period) || "monthly") as Period;
  const timeZone = text(body.timeZone) || "America/New_York";
  const customSince = text(body.since);
  const customUntil = text(body.until);
  /**
   * The campaigns the report is allowed to mention, chosen on the builder.
   *
   * Absent means all of them, so a caller that has never heard of the checkboxes still gets a full
   * report. An empty array is different: it is somebody having unticked everything, and it is obeyed.
   */
  const campaignIds = Array.isArray(body.campaignIds) ? body.campaignIds.map(text).filter(Boolean) : null;
  const { since, until, label } = periodRange(period, timeZone, { since: customSince, until: customUntil });

  /**
   * The same window, but stated as two real dates.
   *
   * `since`/`until` are null for an open-ended period, which our own scans read as "no bound".
   * HeyReach's stats endpoint has no such notion and needs both ends, so all-time becomes a floor
   * that predates the agency and a ceiling of now. It filters by activity, so a window wider than the
   * data costs nothing.
   */
  const statsSince = since ?? "2020-01-01T00:00:00.000Z";
  const statsUntil = until ?? new Date().toISOString();

  try {
    // Resolve workspace(s)
    const workspaces = await query(
      url,
      key,
      `rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,website_url,client_brief,heyreach_api_key_ciphertext${workspaceSlug && workspaceSlug !== "all" ? `&slug=eq.${encodeURIComponent(workspaceSlug)}` : ""}&order=name.asc`,
    );
    if (!workspaces.length)
      return NextResponse.json({ ok: false, error: "No matching client." }, { status: 404 });

    const workspaceIds = workspaces.map((w) => text(w.id));
    const workspaceById = new Map(workspaces.map((w) => [text(w.id), w]));

    /**
     * What HeyReach knows: which campaigns are live, and how the outbound funnel performed.
     *
     * Started here and awaited after the Supabase scans below — the two have nothing to say to each
     * other and running them in sequence would add HeyReach's latency to every report for no reason.
     *
     * The funnel waits on the status because it needs campaign ids to scope itself to, and when the
     * caller has not picked any it takes every campaign the account has. Asking HeyReach for stats
     * with an empty id list would silently widen the rates to the whole account, which is the one
     * answer that must never be printed next to a named set of campaigns.
     */
    const heyReachPending = Promise.all(
      workspaces.map(async (workspace) => {
        const apiKey = text(workspace.heyreach_api_key_ciphertext);
        const status = selectCampaigns(await campaignStatusFor(apiKey), campaignIds);
        const ids = campaignIds ?? allCampaigns(status).map((row) => row.id);
        const funnel = status.available
          ? await campaignFunnelFor(apiKey, ids, statsSince, statsUntil)
          : emptyFunnel(status.reason);
        return [text(workspace.id), { status, funnel }] as const;
      }),
    );

    // Fetch conversations for scope
    const conversations = await query(
      url,
      key,
      `rr_conversations?select=id,lead_id,workspace_id,last_message_at,last_message_direction&workspace_id=in.(${workspaceIds.map(encodeURIComponent).join(",")})&limit=20000`,
    );
    const conversationIds = conversations.map((c) => text(c.id));
    const workspaceByConversation = new Map(conversations.map((c) => [text(c.id), text(c.workspace_id)]));

    // Fetch messages within the period. The workspace filter is applied client-side after
    // dedupe because PostgREST cannot cheaply join.
    const messageFilters = [
      "direction=eq.inbound",
      since ? `sent_at=gte.${encodeURIComponent(since)}` : "",
      until ? `sent_at=lt.${encodeURIComponent(until)}` : "",
    ]
      .filter(Boolean)
      .join("&");
    const rawMessages = await queryByIds(conversationIds, 20, (batch) =>
      query(
        url,
        key,
        `rr_messages?select=id,conversation_id,direction,body,sent_at,raw_data&conversation_id=in.(${batch.map(encodeURIComponent).join(",")})&${messageFilters}&order=sent_at.desc&limit=20000`,
      ),
    );
    const messages = dedupeMessages(rawMessages);

    // Fetch leads for enrichment context
    const leadIds = [...new Set(conversations.map((c) => text(c.lead_id)).filter(Boolean))];
    const leads = await queryByIds(leadIds, 40, (batch) =>
      query(
        url,
        key,
        `rr_leads?select=id,name,role,company,linkedin_profile_url,raw_data,workspace_id&id=in.(${batch.map(encodeURIComponent).join(",")})`,
      ),
    );
    const leadById = new Map(leads.map((l) => [text(l.id), l]));
    const leadByConversation = new Map(
      conversations.map((c) => [text(c.id), leadById.get(text(c.lead_id))]),
    );

    // ── Aggregations ────────────────────────────────────────────────
    const messagesByWorkspace = new Map<string, Row[]>();
    for (const message of messages) {
      const workspaceId = workspaceByConversation.get(text(message.conversation_id)) || "";
      if (!workspaceId) continue;
      const bucket = messagesByWorkspace.get(workspaceId);
      if (bucket) bucket.push(message);
      else messagesByWorkspace.set(workspaceId, [message]);
    }

    const heyReachByWorkspace = new Map<string, { status: CampaignStatus; funnel: CampaignFunnel }>(
      await heyReachPending,
    );

    const clientReports = workspaces.map((workspace) => {
      const workspaceId = text(workspace.id);
      const workspaceMessages = messagesByWorkspace.get(workspaceId) || [];
      const totalReplies = workspaceMessages.length;

      // Sentiment breakdown
      const sentimentCounts: Record<string, number> = { positive: 0, neutral: 0, negative: 0, unclassified: 0 };
      for (const message of workspaceMessages) {
        const sentiment = text(radarOf(message.raw_data).sentiment).toLowerCase();
        if (sentiment === "positive" || sentiment === "neutral" || sentiment === "negative") sentimentCounts[sentiment] += 1;
        else sentimentCounts.unclassified += 1;
      }
      const positiveRate = totalReplies ? (sentimentCounts.positive / totalReplies) * 100 : 0;

      // Campaign performance
      const campaigns = new Map<string, { name: string; replies: number; positive: number; negative: number }>();
      for (const message of workspaceMessages) {
        const campaign = object(radarOf(message.raw_data).campaign);
        const name = text(campaign.name) || "— Unattributed —";
        const bucket = campaigns.get(name) || { name, replies: 0, positive: 0, negative: 0 };
        bucket.replies += 1;
        const sentiment = text(radarOf(message.raw_data).sentiment).toLowerCase();
        if (sentiment === "positive") bucket.positive += 1;
        if (sentiment === "negative") bucket.negative += 1;
        campaigns.set(name, bucket);
      }
      // Live status, joined onto the reply-derived rows by name because reply attribution carries a
      // campaign name and not an id. A row with no match keeps an empty state rather than being
      // called dormant — the campaign may simply have been renamed since the reply came in.
      const heyReach = heyReachByWorkspace.get(workspaceId);
      const campaignStatus = heyReach?.status ?? emptyStatus("Status was not requested.");
      const liveByName = stateByName(campaignStatus);
      const campaignRows = [...campaigns.values()]
        .sort((a, b) => b.replies - a.replies)
        .map((row) => {
          const live = liveByName.get(row.name.trim().toLowerCase());
          return {
            ...row,
            positiveRate: row.replies ? Math.round((row.positive / row.replies) * 100) : 0,
            state: live?.state ?? "",
            status: live?.status ?? "",
            active: live?.state === "active",
          };
        });

      // Campaigns that are active but produced no replies in the period. These exist nowhere in our
      // own data — a silent campaign is indistinguishable from an absent one — and they are the reason
      // this fetch is here at all.
      const repliedCampaignNames = new Set([...campaigns.keys()].map((name) => name.trim().toLowerCase()));
      const activeWithoutReplies = campaignStatus.active.filter(
        (row) => !repliedCampaignNames.has(row.name.trim().toLowerCase()),
      );

      // Sender leaderboard
      const senders = new Map<string, { name: string; replies: number; positive: number }>();
      for (const message of workspaceMessages) {
        const sender = object(radarOf(message.raw_data).sender);
        const name = text(sender.name) || "— Unassigned —";
        const bucket = senders.get(name) || { name, replies: 0, positive: 0 };
        bucket.replies += 1;
        if (text(radarOf(message.raw_data).sentiment).toLowerCase() === "positive") bucket.positive += 1;
        senders.set(name, bucket);
      }
      const senderRows = [...senders.values()]
        .sort((a, b) => b.replies - a.replies)
        .slice(0, 12)
        .map((row) => ({
          ...row,
          positiveRate: row.replies ? Math.round((row.positive / row.replies) * 100) : 0,
        }));

      // Reply timing: hour of day distribution (0-23) in workspace timezone
      const workspaceZone = text(workspace.timezone) || timeZone;
      const hours = new Array(24).fill(0);
      for (const message of workspaceMessages) {
        const sentAt = new Date(text(message.sent_at));
        if (Number.isNaN(sentAt.getTime())) continue;
        const hour = Number(
          new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: workspaceZone })
            .format(sentAt)
            .replace(/\D/g, ""),
        );
        if (!Number.isNaN(hour) && hour >= 0 && hour < 24) hours[hour] += 1;
      }

      // Trend chart: replies per day
      const trend = new Map<string, number>();
      for (const message of workspaceMessages) {
        const sentAt = new Date(text(message.sent_at));
        if (Number.isNaN(sentAt.getTime())) continue;
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: workspaceZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(sentAt);
        trend.set(day, (trend.get(day) || 0) + 1);
      }
      const trendRows = [...trend.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, replies]) => ({ day, replies }));

      // Top leads: highest ICP scores, only leads in this workspace with a reply
      const repliedLeadIds = new Set(
        workspaceMessages
          .map((message) => leadByConversation.get(text(message.conversation_id)))
          .filter(Boolean)
          .map((lead) => text((lead as Row).id)),
      );
      const workspaceLeads = leads.filter((lead) => text(lead.workspace_id) === workspaceId);
      const topLeads = workspaceLeads
        .filter((lead) => repliedLeadIds.has(text(lead.id)))
        .map((lead) => {
          const radar = radarOf(lead.raw_data);
          return {
            id: text(lead.id),
            name: text(lead.name) || "—",
            role: text(lead.role) || "",
            company: text(lead.company) || "",
            icpScore: Number(radar.icp_score) || 0,
            icpReason: text(radar.icp_reason) || "",
            profileUrl: text(lead.linkedin_profile_url) || "",
          };
        })
        .sort((a, b) => b.icpScore - a.icpScore)
        .slice(0, 15);

      // ICP distribution
      const icpBuckets = { excellent: 0, strong: 0, moderate: 0, weak: 0 };
      for (const lead of workspaceLeads) {
        const score = Number(radarOf(lead.raw_data).icp_score);
        if (!Number.isFinite(score)) continue;
        icpBuckets[bucketIcp(score)] += 1;
      }

      // Hot conversations: latest inbound with high follow-up urgency
      const hotConversations: Array<{ leadName: string; role: string; company: string; sentAt: string; urgency: number; snippet: string; campaign: string }> = [];
      const seenConversations = new Set<string>();
      const sortedByRecency = [...workspaceMessages].sort((a, b) =>
        text(b.sent_at).localeCompare(text(a.sent_at)),
      );
      for (const message of sortedByRecency) {
        const conversationId = text(message.conversation_id);
        if (seenConversations.has(conversationId)) continue;
        seenConversations.add(conversationId);
        const radar = radarOf(message.raw_data);
        const urgency = Number(radar.followup_urgency);
        if (!Number.isFinite(urgency) || urgency < 60) continue;
        const lead = leadByConversation.get(conversationId);
        hotConversations.push({
          leadName: text(lead?.name) || "—",
          role: text(lead?.role) || "",
          company: text(lead?.company) || "",
          sentAt: text(message.sent_at),
          urgency,
          snippet: text(message.body).slice(0, 240),
          campaign: text(object(radar.campaign).name) || "—",
        });
        if (hotConversations.length >= 10) break;
      }

      // Sample positive replies
      const sampleReplies = workspaceMessages
        .filter((message) => text(radarOf(message.raw_data).sentiment).toLowerCase() === "positive")
        .slice(0, 6)
        .map((message) => {
          const conversationId = text(message.conversation_id);
          const lead = leadByConversation.get(conversationId);
          const radar = radarOf(message.raw_data);
          return {
            leadName: text(lead?.name) || "—",
            role: text(lead?.role) || "",
            company: text(lead?.company) || "",
            sentAt: text(message.sent_at),
            body: text(message.body),
            campaign: text(object(radar.campaign).name) || "—",
            senderName: text(object(radar.sender).name) || "—",
          };
        });

      /**
       * The five replies worth quoting to the client.
       *
       * "Best" has to be decided from something we actually store, and the closest thing to "this reply
       * was great" is a positive reply the scorer thought needed answering soonest — follow-up urgency is
       * the model's read of how much intent is in the message. Ties break on recency, because between two
       * equally strong replies the client would rather hear about this week's.
       *
       * One per conversation. Someone enthusiastic across three messages is one good reply, not three,
       * and without this the whole section can be a single lead talking to themselves.
       */
      const seenBestConversations = new Set<string>();
      const bestReplies = sortedByRecency
        .filter((message) => text(radarOf(message.raw_data).sentiment).toLowerCase() === "positive")
        .filter((message) => Boolean(text(message.body).trim()))
        .filter((message) => {
          const conversationId = text(message.conversation_id);
          if (seenBestConversations.has(conversationId)) return false;
          seenBestConversations.add(conversationId);
          return true;
        })
        .sort((a, b) => {
          const urgency = (row: Row) => Number(radarOf(row.raw_data).followup_urgency) || 0;
          return urgency(b) - urgency(a) || text(b.sent_at).localeCompare(text(a.sent_at));
        })
        .slice(0, 5)
        .map((message) => {
          const lead = leadByConversation.get(text(message.conversation_id));
          return {
            leadName: text(lead?.name) || "—",
            role: text(lead?.role) || "",
            company: text(lead?.company) || "",
            sentAt: text(message.sent_at),
            body: text(message.body).slice(0, 600),
          };
        });

      // Executive summary numbers
      const bestCampaign = campaignRows[0]?.name || "—";
      const bestSender = senderRows[0]?.name || "—";
      const daysCovered = trendRows.length || 1;
      const avgRepliesPerDay = totalReplies / daysCovered;

      return {
        workspace: {
          id: workspaceId,
          slug: text(workspace.slug),
          name: text(workspace.name),
          logoUrl: text(workspace.logo_url),
          accentColor: text(workspace.accent_color),
          website: text(workspace.website_url),
          clientBrief: text(workspace.client_brief),
          timezone: workspaceZone,
        },
        summary: {
          totalReplies,
          positiveReplies: sentimentCounts.positive,
          neutralReplies: sentimentCounts.neutral,
          negativeReplies: sentimentCounts.negative,
          unclassifiedReplies: sentimentCounts.unclassified,
          positiveRate,
          avgRepliesPerDay,
          bestCampaign,
          bestSender,
          hotCount: hotConversations.length,
          topIcpCount: topLeads.filter((lead) => lead.icpScore >= 75).length,
          activeCampaigns: campaignStatus.available ? campaignStatus.active.length : null,
          scheduledCampaigns: campaignStatus.available ? campaignStatus.scheduled.length : null,
          silentActiveCampaigns: campaignStatus.available ? activeWithoutReplies.length : null,
        },
        /**
         * The outbound funnel joined to our replies: sent, accepted, and the three rates.
         *
         * HeyReach supplies the denominators and we supply the numerators, which is what lets the
         * report's reply rate be divided back out of the reply count printed above it.
         */
        metrics: reportMetrics(heyReach?.funnel ?? emptyFunnel("Rates were not requested."), {
          total: totalReplies,
          positive: sentimentCounts.positive,
          leadsReplied: repliedLeadIds.size,
        }),
        sentiment: sentimentCounts,
        campaigns: campaignRows,
        campaignStatus: {
          ...campaignStatus,
          // Named separately from `active` so a section can list "live, no replies this period"
          // without re-deriving it from two other arrays.
          activeWithoutReplies,
        },
        senders: senderRows,
        topLeads,
        icpBuckets,
        hotConversations,
        sampleReplies,
        bestReplies,
        replyTiming: hours,
        trend: trendRows,
      };
    });

    return NextResponse.json({
      ok: true,
      period,
      periodLabel: label,
      since,
      until,
      generatedAt: new Date().toISOString(),
      clients: clientReports,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Report generation failed" },
      { status: 502 },
    );
  }
}
