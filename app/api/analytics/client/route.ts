// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { queryByIds } from "../../../lib/chunk-query";

/**
 * Everything one client's analytics page draws, out of Supabase and nothing else.
 *
 * `/api/analytics` next door talks to HeyReach for every client before it can answer — a campaign list
 * and a stats rollup each, none of it cacheable for long — which is two to three seconds on the critical
 * path of a page load and the reason the analytics tab opened blank and filled in later. The Render
 * worker now collects the same answers into `rr_campaign_stats` and `rr_daily_stats` every half hour, so
 * this route is a handful of indexed reads against tables we own.
 *
 * The one thing it still computes rather than reads is sentiment. Whether a reply was positive is our
 * judgement, made by the AI pipeline and stored on the message, so it has no equivalent on HeyReach's
 * side and cannot be collected from them.
 */

type Row = Record<string, unknown>;

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}

async function get(path: string): Promise<Row[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase request failed (${response.status})`);
  return (await response.json()) as Row[];
}

/** The last `days` calendar days, oldest first, as `YYYY-MM-DD`. */
function dayKeys(days: number) {
  const keys: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    keys.push(new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10));
  }
  return keys;
}

export async function GET(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, status: "not_configured" }, { status: 503 });
  const slug = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, status: "no_client" }, { status: 400 });

  try {
    const workspaces = await get(`rr_workspaces?select=id,name,slug,logo_url,accent_color&slug=eq.${encodeURIComponent(slug)}&limit=1`);
    const workspace = workspaces[0];
    if (!workspace) return NextResponse.json({ ok: false, status: "not_found" }, { status: 404 });
    const workspaceId = String(workspace.id);

    const [campaignRows, dailyRows, conversations, runs] = await Promise.all([
      get(`rr_campaign_stats?select=*&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=launched_at.desc.nullslast&limit=2000`),
      get(`rr_daily_stats?select=*&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=day.asc&limit=2000`),
      get(`rr_conversations?select=id&workspace_id=eq.${encodeURIComponent(workspaceId)}&limit=2000`),
      /*
       * The last few collection passes for this client, which is what the page's progress bar is made
       * of. `/api/analytics/client/refresh` queues a row here and the worker moves it queued → running
       * → success, so every step the bar shows is a state somebody wrote rather than a timer running.
       */
      get(`rr_sync_runs?select=status,started_at,finished_at,error_text&workspace_id=eq.${encodeURIComponent(workspaceId)}&run_type=eq.analytics&order=started_at.desc&limit=4`),
    ]);

    /*
     * Inbound messages, with the two fields needed lifted out of the JSON by PostgREST rather than
     * downloaded whole. `raw_data` on a message is the entire stored HeyReach payload; selecting it to
     * read one string out of it is how the analytics route came to move megabytes to count sentiments.
     */
    const conversationIds = conversations.map((row) => String(row.id)).filter(Boolean);
    const inbound = await queryByIds(conversationIds, 20, async (batch) =>
      get(
        `rr_messages?select=conversation_id,sent_at,sentiment:raw_data->reply_radar->>sentiment,campaign:raw_data->reply_radar->campaign->>name` +
          `&direction=eq.inbound&conversation_id=in.(${batch.map(encodeURIComponent).join(",")})&limit=1000`,
      ),
    );

    const positiveByCampaign = new Map<string, number>();
    const repliesByCampaign = new Map<string, number>();
    const weekAgo = Date.now() - 7 * 86_400_000;
    let replies7d = 0;
    for (const message of inbound) {
      const campaign = String(message.campaign ?? "").trim().toLowerCase();
      if (Date.parse(String(message.sent_at ?? "")) >= weekAgo) replies7d += 1;
      if (!campaign) continue;
      repliesByCampaign.set(campaign, (repliesByCampaign.get(campaign) ?? 0) + 1);
      if (String(message.sentiment ?? "").toLowerCase() === "positive") {
        positiveByCampaign.set(campaign, (positiveByCampaign.get(campaign) ?? 0) + 1);
      }
    }

    /*
     * The per-sender daily cap, taken from what HeyReach reports rather than assumed.
     *
     * It is 25 on every account measured, and "days of sending left" is a division by it, so a wrong
     * value here would be a wrong forecast on every active campaign. The highest cap on the account is
     * used when a sender's own is missing, and 25 only if nothing at all was reported.
     */
    const caps = dailyRows.map((row) => num(row.daily_limit)).filter((value) => value > 0);
    const senderCap = caps.length ? Math.max(...caps) : 25;

    const campaigns = campaignRows.map((row) => {
      const name = String(row.name ?? "");
      const key = name.trim().toLowerCase();
      const sent = num(row.connections_sent);
      const accepted = num(row.connections_accepted);
      // HeyReach's lifetime reply count covers the whole campaign; ours covers what reached the inbox.
      // The rate is taken from theirs, because theirs is the complete number.
      const replies = num(row.replies);
      const positiveReplies = positiveByCampaign.get(key) ?? 0;
      const senderIds = Array.isArray(row.sender_ids) ? row.sender_ids.map((value) => String(value)) : [];
      const pending = num(row.leads_pending);
      // Every assigned sender works the campaign in parallel, each to its own daily cap, so the whole
      // campaign's daily throughput is the cap times the number of senders on it.
      const dailyCapacity = senderIds.length * senderCap;
      return {
        campaignId: String(row.campaign_id ?? ""),
        name,
        status: String(row.status ?? "") || null,
        launchedAt: row.launched_at ? String(row.launched_at) : null,
        senderIds,
        totalLeads: num(row.total_leads),
        leadsPending: pending,
        leadsInProgress: num(row.leads_in_progress),
        leadsFinished: num(row.leads_finished),
        connectionsSent: sent,
        connectionsAccepted: accepted,
        replies,
        repliesSynced: repliesByCampaign.get(key) ?? 0,
        messagesStarted: num(row.messages_started),
        positiveReplies,
        acceptanceRate: sent ? (accepted / sent) * 100 : 0,
        // Against accepted rather than sent: nobody can reply to a request that was never accepted, so
        // dividing by everything sent measures the invite note twice and the message not at all.
        replyRate: accepted ? (replies / accepted) * 100 : 0,
        positiveReplyRate: accepted ? (positiveReplies / accepted) * 100 : 0,
        firstTouch: row.first_touch ? String(row.first_touch) : null,
        followUp: row.follow_up ? String(row.follow_up) : null,
        sequenceSteps: row.sequence_steps == null ? null : num(row.sequence_steps),
        // Whole days, rounded up: a campaign with one lead left has a day of sending left, not none.
        daysLeft: pending > 0 && dailyCapacity > 0 ? Math.ceil(pending / dailyCapacity) : pending > 0 ? null : 0,
      };
    });

    const days = dayKeys(14);
    const totalsByDay = new Map<string, Row>();
    const senders = new Map<string, { id: string; name: string; dailyLimit: number | null; byDay: Map<string, number>; connectionsSent: number; connectionsAccepted: number }>();
    for (const row of dailyRows) {
      const day = String(row.day ?? "").slice(0, 10);
      const senderId = String(row.sender_id ?? "");
      // `sender_id = ''` is the client-wide row the worker stores alongside the per-sender ones, so
      // that the headline chart matches HeyReach's dashboard even if a sender is later disconnected.
      if (!senderId) {
        totalsByDay.set(day, row);
        continue;
      }
      const sender = senders.get(senderId) ?? {
        id: senderId,
        name: String(row.sender_name ?? "") || `Sender ${senderId}`,
        dailyLimit: num(row.daily_limit) || null,
        byDay: new Map<string, number>(),
        connectionsSent: 0,
        connectionsAccepted: 0,
      };
      if (days.includes(day)) {
        sender.byDay.set(day, num(row.connections_sent));
        sender.connectionsSent += num(row.connections_sent);
        sender.connectionsAccepted += num(row.connections_accepted);
      }
      senders.set(senderId, sender);
    }

    const daily = days.map((day) => {
      const row = totalsByDay.get(day);
      return {
        day,
        label: new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "UTC" }),
        connectionsSent: num(row?.connections_sent),
        connectionsAccepted: num(row?.connections_accepted),
        messagesSent: num(row?.messages_sent),
        replies: num(row?.replies),
      };
    });

    const senderSeries = [...senders.values()]
      // Senders with nothing in the window are left out rather than drawn as an empty stripe with a
      // name attached — the chart is about who is sending, and they are not.
      .filter((sender) => sender.connectionsSent > 0)
      .sort((left, right) => right.connectionsSent - left.connectionsSent)
      .map((sender) => ({
        id: sender.id,
        name: sender.name,
        dailyLimit: sender.dailyLimit,
        connectionsSent: sender.connectionsSent,
        connectionsAccepted: sender.connectionsAccepted,
        byDay: days.map((day) => sender.byDay.get(day) ?? 0),
      }));

    const refreshed = campaignRows
      .map((row) => Date.parse(String(row.refreshed_at ?? "")))
      .filter((value) => Number.isFinite(value));

    const pending = runs.find((run) => {
      const state = String(run.status ?? "").toLowerCase();
      return state === "queued" || state === "running";
    });
    const settled = runs.find((run) => {
      const state = String(run.status ?? "").toLowerCase();
      return state !== "queued" && state !== "running";
    });

    return NextResponse.json({
      ok: true,
      status: campaigns.length ? "live" : "no_data",
      workspace: {
        id: workspaceId,
        name: String(workspace.name ?? ""),
        slug: String(workspace.slug ?? ""),
        logoUrl: workspace.logo_url ? String(workspace.logo_url) : null,
        accentColor: workspace.accent_color ? String(workspace.accent_color) : null,
      },
      campaigns,
      daily,
      dayLabels: daily.map((row) => row.label),
      senders: senderSeries,
      senderCap,
      // What the inbox holds, as distinct from what HeyReach counted. The gap is the point: it is the
      // difference between every reply the campaign ever got and the ones we are working.
      repliesSynced: inbound.length,
      replies7d,
      conversations: conversationIds.length,
      collectedAt: refreshed.length ? new Date(Math.max(...refreshed)).toISOString() : null,
      sync: {
        // `queued` means the worker has not picked it up yet, `running` means it is mid-pass, and
        // `idle` means the stored figures are the whole story until the next daily turn.
        state: pending ? (String(pending.status).toLowerCase() === "running" ? "running" : "queued") : "idle",
        requestedAt: pending?.started_at ? String(pending.started_at) : null,
        lastStatus: settled?.status ? String(settled.status) : null,
        lastFinishedAt: settled?.finished_at ? String(settled.finished_at) : null,
        lastError: settled?.error_text ? String(settled.error_text) : null,
      },
    });
  } catch (error) {
    return NextResponse.json({ ok: false, status: "error", error: error instanceof Error ? error.message : "Client analytics unavailable" }, { status: 502 });
  }
}
