import { NextResponse } from "next/server";
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
    const result = conversations.map((conversation) => {
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
      const name = String(lead.name || "Unknown lead");
      return {
        id: conversation.id,
        leadId: lead.id,
        initials: initials(name),
        name,
        role: String(lead.role || lead.title || enrichment.title || ""),
        company: String(lead.company || ""),
        profileUrl: lead.linkedin_profile_url ?? lead.profile_url ?? null,
        photoUrl: enrichment.profilePhotoSource ?? enrichment.profilePhotoUrl ?? null,
        companyPhotoUrl: enrichment.companyPhotoSource ?? enrichment.companyPhotoUrl ?? null,
        headline: enrichment.headline ?? null,
        enrichedLocation: enrichment.location ?? null,
        industry: enrichment.industry ?? null,
        campaignName: campaign.name ?? null,
        client: String(workspace.name || workspace.slug || "Unknown client"),
        clientSlug: workspace.slug,
        clientTone: String(workspace.accent_color || "#8b7cff"),
        clientLogoUrl: workspace.logo_url ?? null,
        senderName,
        leadScore: null,
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
