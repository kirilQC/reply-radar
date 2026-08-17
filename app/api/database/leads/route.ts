// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { normalizePersonName } from "../../../lib/person-name";
import { countRows } from "../../../lib/rest-count";
import { leadSortOrder } from "../../../lib/lead-sort";
type Row = Record<string, unknown>;
const field = (value: unknown, key: string) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)[key]
    : undefined;

/**
 * The first of `keys` that the stored HeyReach payload actually has a value for.
 *
 * Last resort behind the lead's own columns and enrichment, and worth having because a lead stored
 * before those columns were filled in still carries the payload it arrived with. Both spellings are
 * tried: the webhook envelope is snake_case and the inbox API is camelCase.
 */
const heyReachField = (raw: Row, keys: string[]) => {
  for (const key of keys) {
    const value = raw[key];
    const resolved = value && typeof value === "object" ? field(value, "name") : value;
    if (typeof resolved === "string" && resolved.trim()) return resolved.trim();
  }
  return "";
};

async function get(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok)
    throw new Error(`Supabase ${response.status}: ${JSON.stringify(data)}`);
  return Array.isArray(data) ? (data as Row[]) : [];
}
/**
 * The cursor is a row offset, not a timestamp.
 *
 * It used to carry the last row's `created_at` and page with `created_at=lt.<cursor>`, which is the
 * better technique — but it only works while `created_at` is also the sort key. Ordering by name and
 * then asking for "created before the last row" returns nonsense. Keyset paging on an arbitrary
 * column means a composite `or=(col.gt.x,and(col.eq.x,created_at.lt.y))` filter, and there is already
 * an `or=` on this query for search, which PostgREST will not let us have twice.
 *
 * An offset is uniform across every sort and correct for what this page is: someone browsing a table
 * fifty rows at a time. Its known weakness — a row inserted mid-paging shifts the window — is a
 * cosmetic duplicate on page two of a table that grows by webhook, and the timestamp cursor it
 * replaces had a comparable hole anyway, since `lt` drops rows sharing the boundary timestamp.
 *
 * Base64 is kept so the shape of the value is unchanged for any client holding an old one; a stale
 * timestamp cursor decodes to NaN and lands harmlessly on the first page.
 */
const encodeCursor = (offset: unknown) =>
  Buffer.from(String(offset)).toString("base64url");
const decodeCursor = (cursor: string | null) => {
  try {
    const decoded = cursor ? Buffer.from(cursor, "base64url").toString("utf8") : "";
    const offset = Math.floor(Number(decoded));
    // The ceiling is the same order of magnitude as the 10,000-row filter reads below, and stops a
    // hand-edited cursor from asking Postgres to count past a million rows before answering.
    return Number.isFinite(offset) && offset > 0 ? Math.min(offset, 100_000) : 0;
  } catch {
    return 0;
  }
};
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
        : raw.campaign && typeof raw.campaign === "object"
          ? (raw.campaign as Row)
          : {};
    if (campaign.name || campaign.id) return campaign;
  }
  return {};
};
const uniqueNames = (values: unknown[], kind: "sender" | "campaign") => [
  ...new Set(
    values
      .map((value) => {
        const raw = value && typeof value === "object" ? (value as Row) : {};
        const metadata =
          raw.reply_radar && typeof raw.reply_radar === "object"
            ? (raw.reply_radar as Row)
            : {};
        const record =
          metadata[kind] && typeof metadata[kind] === "object"
            ? (metadata[kind] as Row)
            : raw[kind] && typeof raw[kind] === "object"
              ? (raw[kind] as Row)
              : {};
        return String(record.name ?? "").trim();
      })
      .filter(Boolean),
  ),
];
const nested = (value: unknown, key: string) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as Row)[key] &&
  typeof (value as Row)[key] === "object"
    ? ((value as Row)[key] as Row)
    : {};
const rollupNames = (rawValue: unknown, key: "campaigns" | "senders") => {
  const raw = rawValue && typeof rawValue === "object" ? rawValue as Row : {};
  const rollup = nested(nested(raw, "reply_radar"), "rollup");
  const values = Array.isArray(rollup[key]) ? rollup[key] : [];
  return [...new Set(values.map(String).map((value) => value.trim()).filter(Boolean))];
};
const timeRangeDays: Record<string, number> = { "7d": 7, "14d": 14, "1m": 30, "3m": 90 };
const locationLabel = (value: unknown) =>
  typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? String(
          (value as Row).default ||
            (value as Row).short ||
            [(value as Row).city, (value as Row).state, (value as Row).country]
              .filter(Boolean)
              .join(", ") ||
            "",
        )
      : "";

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key)
    return NextResponse.json(
      { ok: false, leads: [], error: "Supabase is not configured." },
      { status: 503 },
    );
  try {
    const params = new URL(request.url).searchParams;
    const workspaceSlug = params.get("workspace")?.trim() ?? "";
    const senderFilter = (params.get("sender") ?? "").trim().slice(0, 160);
    const campaignFilter = (params.get("campaign") ?? "").trim().slice(0, 200);
    const timeRange = (params.get("timeRange") ?? "all").trim();
    const search = (params.get("search") ?? "")
      .trim()
      .slice(0, 100)
      .replace(/[,*.()]/g, " ");
    const limit = Math.min(
      100,
      Math.max(10, Number(params.get("limit") || 50)),
    );
    const offset = decodeCursor(params.get("cursor"));
    const order = leadSortOrder(params.get("sort"));
    const workspaces = await get(
      url,
      key,
      "rr_workspaces?select=id,name,slug,logo_url,accent_color&order=name.asc",
    );
    const selectedWorkspace = workspaceSlug
      ? workspaces.find((workspace) => workspace.slug === workspaceSlug)
      : null;
    if (workspaceSlug && !selectedWorkspace)
      return NextResponse.json({
        ok: true,
        leads: [],
        workspaces,
        hasMore: false,
        nextCursor: null,
      });
    const filters = [
      selectedWorkspace
        ? `workspace_id=eq.${encodeURIComponent(String(selectedWorkspace.id))}`
        : "",
      search
        ? `or=(name.ilike.*${encodeURIComponent(search)}*,company.ilike.*${encodeURIComponent(search)}*,role.ilike.*${encodeURIComponent(search)}*,linkedin_id.ilike.*${encodeURIComponent(search)}*)`
        : "",
    ]
      .filter(Boolean)
      .join("&");
    const metadataFiltering = Boolean(selectedWorkspace && (senderFilter || campaignFilter || timeRangeDays[timeRange]));
    // Sender, campaign and time-range filters are decided in memory below, so that path has to read
    // the whole filtered set from row one and take its page afterwards — an offset in the query would
    // skip rows before the filter ever saw them. Everything else pages in the database.
    let rows = await get(
      url,
      key,
      `rr_leads?select=*&${filters ? `${filters}&` : ""}order=${order}&limit=${metadataFiltering ? 10000 : limit + 1}${metadataFiltering || !offset ? "" : `&offset=${offset}`}`,
    );
    const optionRows = selectedWorkspace
      ? await get(url, key, `rr_leads?select=raw_data&workspace_id=eq.${encodeURIComponent(String(selectedWorkspace.id))}&limit=10000`)
      : [];
    const filterOptions = {
      senders: [...new Set(optionRows.flatMap((lead) => rollupNames(lead.raw_data, "senders")))].sort((a, b) => a.localeCompare(b)),
      campaigns: [...new Set(optionRows.flatMap((lead) => rollupNames(lead.raw_data, "campaigns")))].sort((a, b) => a.localeCompare(b)),
    };
    if (senderFilter) rows = rows.filter((lead) => rollupNames(lead.raw_data, "senders").includes(senderFilter));
    if (campaignFilter) rows = rows.filter((lead) => rollupNames(lead.raw_data, "campaigns").includes(campaignFilter));
    if (selectedWorkspace && timeRangeDays[timeRange] && rows.length) {
      const since = new Date(Date.now() - timeRangeDays[timeRange] * 86_400_000).toISOString();
      const recentConversations = await get(url, key, `rr_conversations?select=lead_id&workspace_id=eq.${encodeURIComponent(String(selectedWorkspace.id))}&last_message_at=gte.${encodeURIComponent(since)}&limit=10000`);
      const recentLeadIds = new Set(recentConversations.map((row) => String(row.lead_id)));
      rows = rows.filter((lead) => recentLeadIds.has(String(lead.id)));
    }
    // Sender, campaign and time-range filters are applied in memory, so in that case the filtered set
    // in hand already is the answer. Otherwise ask the database, since paging only ever sees one page.
    // The cursor is left out either way: it narrows to "everything after this page", which is a
    // paging detail, not something the reader is filtering by.
    const countFilters = [
      selectedWorkspace ? `workspace_id=eq.${encodeURIComponent(String(selectedWorkspace.id))}` : "",
      search ? `or=(name.ilike.*${encodeURIComponent(search)}*,company.ilike.*${encodeURIComponent(search)}*,role.ilike.*${encodeURIComponent(search)}*,linkedin_id.ilike.*${encodeURIComponent(search)}*)` : "",
    ].filter(Boolean).join("&");
    const totalLeads = metadataFiltering
      ? rows.length
      : await countRows(url, key, `rr_leads?select=id${countFilters ? `&${countFilters}` : ""}`);
    // The in-memory path holds the whole filtered set, so its page is cut out of the middle; the
    // database path was already handed the offset and returns the page plus one probe row.
    const page = metadataFiltering ? rows.slice(offset, offset + limit) : rows.slice(0, limit);
    const hasMore = metadataFiltering ? rows.length > offset + limit : rows.length > limit;
    const leadIds = page.map((lead) => String(lead.id));
    const conversations = leadIds.length
      ? await get(
          url,
          key,
          `rr_conversations?select=id,lead_id,last_message_at,last_message_direction,score,tier&lead_id=in.(${leadIds.join(",")})&order=last_message_at.desc`,
        )
      : [];
    const conversationIds = conversations.map((conversation) =>
      String(conversation.id),
    );
    const messages = conversationIds.length
      ? await get(
          url,
          key,
          `rr_messages?select=conversation_id,direction,body,sent_at,raw_data&conversation_id=in.(${conversationIds.join(",")})&order=sent_at.desc&limit=1000`,
        )
      : [];
    const workspaceById = new Map(
      workspaces.map((workspace) => [String(workspace.id), workspace]),
    );
    const leads = page.map((lead) => {
      const raw =
        lead.raw_data && typeof lead.raw_data === "object"
          ? (lead.raw_data as Row)
          : {};
      const metadata = nested(raw, "reply_radar");
      const enrichment = nested(metadata, "ai_ark");
      const leadConversations = conversations.filter(
        (conversation) => conversation.lead_id === lead.id,
      );
      const ids = new Set(
        leadConversations.map((conversation) => conversation.id),
      );
      const leadMessages = messages.filter((message) =>
        ids.has(message.conversation_id),
      );
      const latestMessage = leadMessages[0];
      const campaign = campaignFrom(
        ...leadMessages.map((message) => message.raw_data),
        raw,
      );
      const rollup = nested(metadata, "rollup");
      const campaignNames = [
        ...new Set([
          ...(Array.isArray(rollup.campaigns)
            ? rollup.campaigns.map(String)
            : []),
          ...uniqueNames(
            [...leadMessages.map((message) => message.raw_data), raw],
            "campaign",
          ),
        ]),
      ];
      const senderNames = [
        ...new Set([
          ...(Array.isArray(rollup.senders) ? rollup.senders.map(String) : []),
          ...uniqueNames(
            [...leadMessages.map((message) => message.raw_data), raw],
            "sender",
          ),
        ]),
      ];
      const workspace = workspaceById.get(String(lead.workspace_id)) ?? {};
      const enrichmentCompany = nested(enrichment, "company");
      const companySummary = nested(enrichmentCompany, "summary");
      const positionGroups = Array.isArray(enrichment.positionGroups) ? enrichment.positionGroups : [];
      const currentPosition = positionGroups.find((value) => !field(nested(value, "date"), "end"));
      const currentPositionCompany = field(nested(currentPosition, "company"), "name");
      return {
        id: lead.id,
        name: normalizePersonName(lead.name),
        role: lead.role || enrichment.title || heyReachField(raw, ["position", "title", "job_title", "jobTitle", "headline", "occupation"]),
        company:
          lead.company ||
          companySummary.name ||
          enrichmentCompany.name ||
          currentPositionCompany ||
          heyReachField(raw, ["company_name", "companyName", "company", "currentCompany"]),
        linkedinId: lead.linkedin_id ?? null,
        profileUrl: lead.linkedin_profile_url ?? null,
        photoUrl: enrichment.profilePhotoSource ?? enrichment.profilePhotoUrl ?? null,
        companyPhotoUrl: enrichment.companyPhotoSource ?? enrichment.companyPhotoUrl ?? null,
        email:
          raw.email_address ?? raw.custom_email ?? raw.enriched_email ?? null,
        location: locationLabel(raw.location || enrichment.location),
        headline: enrichment.headline ?? null,
        industry: enrichment.industry ?? null,
        campaignName: campaign.name ?? null,
        campaignNames,
        clientCount: Number(rollup.client_count || 0),
        campaignCount: Number(rollup.campaign_count || campaignNames.length),
        enriched: Object.keys(enrichment).length > 0,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        senderName: senderNameFrom(
          ...leadMessages.map((message) => message.raw_data),
          raw,
        ),
        senderNames,
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          logoUrl: workspace.logo_url,
          accentColor: workspace.accent_color,
        },
        createdAt: lead.created_at,
        conversationCount: leadConversations.length,
        replyCount: leadMessages.filter(
          (message) => message.direction === "inbound",
        ).length,
        lastReplyAt: leadConversations[0]?.last_message_at ?? null,
        lastMessage: latestMessage?.body ?? "",
        rawData: raw,
      };
    });
    return NextResponse.json({
      ok: true,
      leads,
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        logoUrl: workspace.logo_url,
      })),
      filterOptions,
      totalLeads,
      filtered: Boolean(selectedWorkspace || search || metadataFiltering),
      hasMore,
      nextCursor: hasMore && page.length ? encodeCursor(offset + page.length) : null,
      pageSize: limit,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        leads: [],
        error: error instanceof Error ? error.message : "Database unavailable",
      },
      { status: 502 },
    );
  }
}
