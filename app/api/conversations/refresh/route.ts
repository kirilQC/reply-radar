import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";
import { extractMessageRows, messageKey, normalizeHeyReachMessages } from "../../../lib/heyreach-conversation";

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const object = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};

const apiBase =
  process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";

async function db(url: string, key: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await response.text();
  let data: unknown = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) throw new Error(`Supabase ${path.split("?")[0]} ${response.status}`);
  return data;
}

async function heyReach(apiKey: string, path: string, init: RequestInit) {
  const response = await fetch(
    `${apiBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
    {
      ...init,
      headers: {
        "X-API-KEY": apiKey,
        accept: "application/json",
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new Error(`HeyReach ${path.split("?")[0]} returned ${response.status}`);
  return response.json().catch(() => null);
}

/** Refresh a single conversation by re-fetching from HeyReach and updating messages. */
async function refreshConversation(
  url: string,
  key: string,
  conversationId: string,
): Promise<{ messagesUpdated: number; newMessages?: number; thread?: { id: string; body: string; direction: string; sentAt: string; authorName: string }[]; lastRefreshedAt?: string; error?: string }> {
  // Load conversation + lead + workspace
  const conversations = (await db(url, key,
    `rr_conversations?select=id,workspace_id,lead_id,heyreach_conversation_id,account_id&id=eq.${encodeURIComponent(conversationId)}&limit=1`,
  )) as Row[];
  const conv = conversations[0];
  if (!conv) return { messagesUpdated: 0, error: "Conversation not found" };

  const workspaces = (await db(url, key,
    `rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(text(conv.workspace_id))}&limit=1`,
  )) as Row[];
  const workspace = workspaces[0];
  const apiKey = text(workspace?.heyreach_api_key_ciphertext);
  if (!apiKey) return { messagesUpdated: 0, error: "No HeyReach API key" };

  const leads = (await db(url, key,
    `rr_leads?select=linkedin_profile_url,raw_data&id=eq.${encodeURIComponent(text(conv.lead_id))}&limit=1`,
  )) as Row[];
  const lead = leads[0];
  const profileUrl = text(lead?.linkedin_profile_url);
  const accountId = text(conv.account_id);
  const heyreachConvId = text(conv.heyreach_conversation_id);

  if (!accountId || !profileUrl) {
    return { messagesUpdated: 0, error: "Missing account_id or profile URL" };
  }

  // Fetch conversation from HeyReach
  let chatroom: unknown = null;
  try {
    chatroom = await heyReach(apiKey, `inbox/GetChatroom/${encodeURIComponent(accountId)}/${encodeURIComponent(heyreachConvId)}`, { method: "GET" });
  } catch {
    // Try via GetConversationsV2 fallback
    try {
      const numericAccount = /^\d+$/.test(accountId) ? Number(accountId) : accountId;
      const listResponse = await heyReach(apiKey, "inbox/GetConversationsV2", {
        method: "POST",
        body: JSON.stringify({ offset: 0, limit: 10, filters: { linkedInAccountIds: [numericAccount], leadProfileUrl: profileUrl } }),
      });
      const items = Array.isArray(listResponse) ? listResponse : (Array.isArray(object(listResponse).items) ? object(listResponse).items as Row[] : []);
      if (items.length) chatroom = items[0];
    } catch {
      return { messagesUpdated: 0, error: "Could not reach HeyReach" };
    }
  }

  if (!chatroom) return { messagesUpdated: 0, error: "No chatroom data returned" };

  const now = new Date().toISOString();
  // Normalised by the same helper the webhook ingestion uses, so a refresh can never disagree
  // with ingestion about who sent a message or what its id is.
  const messages = normalizeHeyReachMessages(extractMessageRows(chatroom), accountId, { id: accountId, name: "" }, now, "history");

  // Get existing messages to merge
  const existing = (await db(url, key,
    `rr_messages?select=id,heyreach_message_id,direction,body,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}`,
  )) as Row[];
  const existingByKey = new Map<string, Row[]>();
  for (const row of existing) {
    const messageIdentity = messageKey(row.sent_at, row.body);
    existingByKey.set(messageIdentity, [...(existingByKey.get(messageIdentity) ?? []), row]);
  }

  // Only insert genuinely NEW messages — never overwrite existing raw_data (which contains sentiment)
  const newRecords = messages
    .filter((m) => !existingByKey.has(messageKey(m.sentAt, m.body)))
    .map((m) => ({
      conversation_id: conversationId,
      heyreach_message_id: m.externalId,
      direction: m.direction,
      body: m.body,
      sent_at: m.sentAt,
      raw_data: { reply_radar: { source: "refresh", refreshed_at: now } },
    }));

  if (newRecords.length) {
    for (let i = 0; i < newRecords.length; i += 200) {
      await db(url, key, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(newRecords.slice(i, i + 200)),
      });
    }
  }

  // Repair rows an earlier release stored with the wrong direction. Because the old dedupe key
  // included the direction, a message we sent could also be saved a second time as if the lead
  // had sent it. Correct the copy worth keeping and drop the leftovers.
  for (const message of messages) {
    const rows = existingByKey.get(messageKey(message.sentAt, message.body));
    if (!rows?.length) continue;
    // Keep whichever row carries AI state, so sentiment, drafts and scores survive the repair.
    const keep =
      rows.find((row) => {
        const radar = object(object(row.raw_data).reply_radar);
        return ["sentiment", "cached_draft", "followup_urgency", "analyzed_at"].some((field) => radar[field] != null);
      }) ?? rows[0];
    if (text(keep.direction) !== message.direction) {
      await db(url, key, `rr_messages?id=eq.${encodeURIComponent(text(keep.id))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ direction: message.direction }),
      }).catch(() => null);
    }
    for (const row of rows) {
      if (row === keep) continue;
      await db(url, key, `rr_messages?id=eq.${encodeURIComponent(text(row.id))}`, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      }).catch(() => null);
    }
  }

  // Update conversation last_message_at and record refresh time
  const latestMessage = [...messages].sort((a, b) => b.sentAt.localeCompare(a.sentAt))[0];
  if (latestMessage) {
    await db(url, key,
      `rr_conversations?id=eq.${encodeURIComponent(conversationId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          last_message_at: latestMessage.sentAt,
          last_message_direction: latestMessage.direction,
          last_refreshed_at: now,
        }),
      },
    );
  }

  // A refresh pulls the whole chatroom, which is precisely what a webhook-only ingest was missing.
  // Recording that unblocks the judgement about who started the conversation, which abstains until
  // it can be sure the earliest stored message really is the earliest message.
  const leadRaw = object(lead?.raw_data);
  if (messages.length && text(object(leadRaw.reply_radar).history_status) !== "complete") {
    await db(url, key, `rr_leads?id=eq.${encodeURIComponent(text(conv.lead_id))}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ raw_data: { ...leadRaw, reply_radar: { ...object(leadRaw.reply_radar), history_status: "complete", history_fetched_at: now } } }),
    }).catch(() => null);
  }

  // Return the full updated message list so the frontend can update in-place
  const updatedMessages = (await db(url, key,
    `rr_messages?select=id,body,direction,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}&order=sent_at.asc`,
  )) as Row[];

  // Determine sender name from existing messages
  const senderName = (() => {
    for (const m of [...updatedMessages].reverse()) {
      const raw = object(m.raw_data);
      const radar = object(raw.reply_radar);
      const sender = object(radar.sender);
      if (sender.name) return text(sender.name);
    }
    return "Unknown sender";
  })();

  // Get lead name
  const leadRows = (await db(url, key,
    `rr_leads?select=name&id=eq.${encodeURIComponent(text(conv.lead_id))}&limit=1`,
  )) as Row[];
  const leadName = text(leadRows[0]?.name) || "Unknown lead";

  const thread = updatedMessages.map((m) => ({
    id: text(m.id),
    body: text(m.body),
    direction: text(m.direction),
    sentAt: text(m.sent_at),
    authorName: text(m.direction) === "outbound" ? senderName : leadName,
  }));

  return { messagesUpdated: newRecords.length, newMessages: newRecords.length, thread, lastRefreshedAt: now };
}

/** POST — refresh one or more conversations. */
export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.conversationIds)
    ? body.conversationIds.map(String).filter(Boolean).slice(0, 50)
    : typeof body.conversationId === "string" && body.conversationId
      ? [body.conversationId]
      : [];

  if (!ids.length) return NextResponse.json({ ok: false, error: "conversationId or conversationIds required" }, { status: 400 });

  const results: { id: string; messagesUpdated: number; newMessages?: number; thread?: unknown[]; lastRefreshedAt?: string; error?: string }[] = [];
  for (const id of ids) {
    try {
      const result = await refreshConversation(url, key, id);
      results.push({ id, ...result });
    } catch (err) {
      results.push({ id, messagesUpdated: 0, error: err instanceof Error ? err.message : "Refresh failed" });
    }
  }

  const refreshed = results.filter((r) => r.messagesUpdated > 0).length;
  if (refreshed) {
    void writeAuditEvent({ url, key }, {
      actor: "System",
      action: "conversations.refreshed",
      entityType: "conversation",
      details: { source: "manual_refresh", status: "success", count: refreshed, summary: `Refreshed ${refreshed} conversation${refreshed === 1 ? "" : "s"} from HeyReach.` },
    });
  }

  return NextResponse.json({ ok: true, refreshed, results });
}
