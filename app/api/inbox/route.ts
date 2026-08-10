import { NextResponse } from "next/server";
import { normalizePersonName } from "../../lib/person-name";
type Row = Record<string, unknown>;

async function query(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok)
    throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data as Row[]) : [];
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";
const nested = (value: unknown, key: string) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as Row)[key] &&
  typeof (value as Row)[key] === "object"
    ? ((value as Row)[key] as Row)
    : {};
const field = (value: unknown, key: string) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)[key]
    : undefined;
const senderNameFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = value && typeof value === "object" ? (value as Row) : {};
    const metadata =
      raw.reply_radar && typeof raw.reply_radar === "object"
        ? (raw.reply_radar as Row)
        : {};
    const sender =
      metadata.sender && typeof metadata.sender === "object"
        ? (metadata.sender as Row)
        : {};
    if (sender.name) return String(sender.name);
  }
  return "Unknown sender";
};
const campaignFrom = (...values: unknown[]) => {
  for (const value of values) {
    const raw = value && typeof value === "object" ? (value as Row) : {};
    const metadata =
      raw.reply_radar && typeof raw.reply_radar === "object"
        ? (raw.reply_radar as Row)
        : {};
    const campaign =
      metadata.campaign && typeof metadata.campaign === "object"
        ? (metadata.campaign as Row)
        : {};
    if (campaign.name || campaign.id) return campaign;
  }
  return {};
};
const computeFollowUp = (thread: { direction: string; sentAt: unknown; body: string }[], sentiment: string | null) => {
  if (!thread.length) return { followUpUrgency: 0, followUpReason: null };
  const now = Date.now();
  const latest = thread[thread.length - 1];
  const latestAt = new Date(String(latest.sentAt)).getTime();
  const ageDays = (now - latestAt) / (1000 * 60 * 60 * 24);
  const inboundMessages = thread.filter((m) => m.direction === "inbound");
  const latestInbound = inboundMessages[inboundMessages.length - 1];
  const latestInboundAt = latestInbound ? new Date(String(latestInbound.sentAt)).getTime() : 0;
  const inboundAgeDays = latestInbound ? (now - latestInboundAt) / (1000 * 60 * 60 * 24) : Infinity;
  const latestBody = String(latest.body || "").toLowerCase();
  const latestInboundBody = latestInbound ? String(latestInbound.body || "").toLowerCase() : "";

  // Skip negative sentiment — lead doesn't want to hear from us
  if (sentiment === "negative") return { followUpUrgency: 0, followUpReason: null };

  let urgency = 0;
  let reason = "";

  // Pattern: Lead replied positively but we haven't followed up
  if (latest.direction === "inbound" && sentiment === "positive" && ageDays >= 1) {
    urgency = Math.min(100, 70 + ageDays * 3);
    reason = `Positive reply ${Math.floor(ageDays)}d ago — awaiting your follow-up.`;
  }
  // Pattern: Lead asked to be contacted later
  else if (latestInboundBody.match(/later|next (month|quarter|year)|few months|circle back|reach out.*(later|again)|not (right )?now|bad time|busy/)) {
    const delayDays = latestInboundBody.match(/next year/) ? 180 : latestInboundBody.match(/next quarter/) ? 60 : latestInboundBody.match(/next month|few months/) ? 30 : 14;
    if (inboundAgeDays >= delayDays) {
      urgency = Math.min(100, 60 + (inboundAgeDays - delayDays) * 2);
      reason = `Said "${latestInboundBody.length > 60 ? latestInboundBody.slice(0, 57) + "…" : latestInboundBody}" ${Math.floor(inboundAgeDays)}d ago — window to re-engage.`;
    }
  }
  // Pattern: No-show — they agreed to meet but went silent
  else if (latestInboundBody.match(/sure|sounds good|let'?s do it|book|schedule|set up|calendar/) && ageDays >= 3) {
    urgency = Math.min(100, 65 + ageDays * 2);
    reason = `Agreed to meet ${Math.floor(inboundAgeDays)}d ago but went silent — possible no-show.`;
  }
  // Pattern: Neutral reply sitting unanswered
  else if (latest.direction === "inbound" && sentiment === "neutral" && ageDays >= 2) {
    urgency = Math.min(100, 40 + ageDays * 2);
    reason = `Neutral reply ${Math.floor(ageDays)}d ago — opportunity to re-engage.`;
  }
  // Pattern: We sent outbound, no reply in 7+ days
  else if (latest.direction === "outbound" && ageDays >= 7 && inboundMessages.length > 0) {
    urgency = Math.min(100, 30 + ageDays);
    reason = `No reply in ${Math.floor(ageDays)}d after your last message — consider a nudge.`;
  }
  // Pattern: Stale conversation with prior engagement
  else if (inboundMessages.length > 0 && ageDays >= 14) {
    urgency = Math.min(100, 25 + ageDays * 0.5);
    reason = `Conversation went cold ${Math.floor(ageDays)}d ago after ${inboundMessages.length} replies — worth revisiting.`;
  }

  if (!reason) return { followUpUrgency: 0, followUpReason: null };
  return { followUpUrgency: Math.round(urgency), followUpReason: reason };
};

const age = (value: unknown) => {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(String(value)).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    return NextResponse.json(
      { ok: false, conversations: [], error: "Supabase is not configured." },
      { status: 503 },
    );
  try {
    const requested =
      new URL(request.url).searchParams
        .get("workspaces")
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean) ?? [];
    const workspaces = await query(
      url,
      key,
      "rr_workspaces?select=id,name,slug,accent_color,logo_url&order=name.asc",
    );
    const selected = requested.length
      ? workspaces.filter((workspace) =>
          requested.includes(String(workspace.slug)),
        )
      : workspaces;
    const workspaceIds = selected.map((workspace) => String(workspace.id));
    if (!workspaceIds.length)
      return NextResponse.json({ ok: true, conversations: [] });
    const conversations = await query(
      url,
      key,
      `rr_conversations?select=*&workspace_id=in.(${workspaceIds.join(",")})&order=last_message_at.desc`,
    );
    const leadIds = [
      ...new Set(
        conversations.map((row) => String(row.lead_id)).filter(Boolean),
      ),
    ];
    const conversationIds = conversations.map((row) => String(row.id));
    const [leads, messages] = await Promise.all([
      leadIds.length
        ? query(url, key, `rr_leads?select=*&id=in.(${leadIds.join(",")})`)
        : [],
      conversationIds.length
        ? query(
            url,
            key,
            `rr_messages?select=*&conversation_id=in.(${conversationIds.join(",")})&order=sent_at.asc`,
          )
        : [],
    ]);
    const workspaceById = new Map(selected.map((row) => [String(row.id), row]));
    const leadById = new Map(leads.map((row) => [String(row.id), row]));
    const result = conversations.filter((conversation) => {
      // Exclude conversations where the lead initiated contact (first message is inbound)
      const convoMessages = messages.filter((m) => m.conversation_id === conversation.id);
      if (!convoMessages.length) return true;
      const firstMessage = convoMessages[0];
      return firstMessage.direction !== "inbound";
    }).map((conversation) => {
      const lead = leadById.get(String(conversation.lead_id)) ?? {};
      const leadRaw =
        lead.raw_data && typeof lead.raw_data === "object"
          ? (lead.raw_data as Row)
          : {};
      const metadata = nested(leadRaw, "reply_radar");
      const enrichment = nested(metadata, "ai_ark");
      const workspace =
        workspaceById.get(String(conversation.workspace_id)) ?? {};
      const messageRows = messages.filter(
        (message) => message.conversation_id === conversation.id,
      );
      const newestRawMessages = [...messageRows]
        .reverse()
        .map((message) => message.raw_data);
      const senderName = senderNameFrom(...newestRawMessages, leadRaw);
      const campaign = campaignFrom(...newestRawMessages, leadRaw);
      const thread = messageRows.map((message) => ({
        id: message.id,
        body: message.body,
        direction: message.direction,
        sentAt: message.sent_at,
        authorName:
          message.direction === "outbound"
            ? senderName
            : String(lead.name || "Unknown lead"),
      }));
      const latest = thread.at(-1);
      const latestReply = thread
        .filter((message) => message.direction === "inbound")
        .at(-1);
      const latestInboundRow = [...messageRows].reverse().find((row) => row.direction === "inbound");
      const latestInboundRaw = latestInboundRow?.raw_data && typeof latestInboundRow.raw_data === "object" ? latestInboundRow.raw_data as Row : {};
      const sentimentData = nested(latestInboundRaw, "reply_radar");
      const sentiment = ["positive", "neutral", "negative"].includes(String(sentimentData.sentiment).toLowerCase()) ? String(sentimentData.sentiment).toLowerCase() : null;
      const name = normalizePersonName(lead.name);
      const { followUpUrgency, followUpReason } = computeFollowUp(
        thread.map((m) => ({ direction: String(m.direction), sentAt: m.sentAt, body: String(m.body) })),
        sentiment,
      );
      const enrichmentCompany = nested(enrichment, "company");
      const companySummary = nested(enrichmentCompany, "summary");
      const positionGroups = Array.isArray(enrichment.positionGroups) ? enrichment.positionGroups : [];
      const currentGroup = positionGroups.find((value) => !field(nested(value, "date"), "end"));
      const currentGroupCompany = field(nested(currentGroup, "company"), "name");
      return {
        id: conversation.id,
        leadId: lead.id,
        initials: initials(name),
        name,
        role: String(lead.role || lead.title || enrichment.title || ""),
        company: String(lead.company || companySummary.name || enrichmentCompany.name || currentGroupCompany || ""),
        profileUrl: lead.linkedin_profile_url ?? lead.profile_url ?? null,
        photoUrl: enrichment.profilePhotoSource ?? enrichment.profilePhotoUrl ?? null,
        companyPhotoUrl: enrichment.companyPhotoSource ?? enrichment.companyPhotoUrl ?? null,
        enriched: Object.keys(enrichment).length > 0,
        headline: enrichment.headline ?? null,
        enrichedLocation: enrichment.location ?? null,
        industry: enrichment.industry ?? null,
        campaignName: campaign.name ?? null,
        client: String(workspace.name || workspace.slug || "Unknown client"),
        clientSlug: workspace.slug,
        clientTone: String(workspace.accent_color || "#8b7cff"),
        clientLogoUrl: workspace.logo_url ?? null,
        senderName,
        leadScore: 0,
        followUpScore: Number(conversation.score || 0),
        score: Number(conversation.score || 0),
        tier: ["hot", "warm", "nurture"].includes(String(conversation.tier))
          ? conversation.tier
          : "nurture",
        reason: String(
          conversation.score_reason || "New reply received from HeyReach.",
        ),
        preview: String(latest?.body || ""),
        age: age(conversation.last_message_at),
        lastMessageAt: conversation.last_message_at,
        latestReplyAt: latestReply?.sentAt ?? conversation.last_message_at,
        replies: thread.filter((message) => message.direction === "inbound")
          .length,
        avatar: "#3c365e",
        sentiment,
        followUpUrgency,
        followUpReason,
        messages: thread,
      };
    });
    return NextResponse.json({ ok: true, conversations: result });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        conversations: [],
        error: error instanceof Error ? error.message : "Inbox unavailable",
      },
      { status: 502 },
    );
  }
}
