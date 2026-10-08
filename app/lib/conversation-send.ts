// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The one function that sends a reply to a lead on LinkedIn, through HeyReach.
 *
 * Shared by the inbox composer (app/api/conversations/reply/route.ts) and the Send Reply button on a
 * Slack reply alert (app/lib/reply-alert-run.ts). Both are a person pressing a confirm control; neither
 * caller may generate or alter the text. The route's header explains every guard below, and why the
 * sent message is written to our own table straight away. Callers own the "a human confirmed this" gate.
 */
import { createHash } from "node:crypto";
import { writeAuditEvent } from "./audit-log";
import { syntheticMessageId } from "./heyreach-conversation";
import { sendEmailConversationReply } from "./email-ingest";
import { isLemlistConversationKey, sendLemlistConversationReply } from "./lemlist-ingest";

type Row = Record<string, unknown>;
export type SendResult = { status: number; ok: boolean; error?: string; sentAt?: string; message?: string };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const apiBase = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public";

/**
 * How long an identical reply counts as already sent.
 *
 * A day, not a minute. Sending the same sentence to the same person twice is never something somebody
 * meant to do, and the cost of refusing a genuine repeat — they change a word — is nothing next to the
 * cost of a lead receiving the same message twice under a client's name.
 */
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** LinkedIn direct messages carry no subject. HeyReach wants the field regardless. */
const SUBJECT = "";

/**
 * The real HeyReach chatroom id, out of the one we store.
 *
 * `rr_conversations.heyreach_conversation_id` is not always HeyReach's id. One chatroom can be
 * attributed to two campaigns or two senders inside the same workspace, and the row is unique on
 * (workspace, conversation) — so ingestion suffixes the id with the campaign and sender to keep both
 * attributions as separate rows (`app/lib/heyreach-ingestion.ts`). The prefix before the first `::`
 * is HeyReach's own id by construction.
 *
 * This matters more here than anywhere else that reads the column. A read given a suffixed id gets a
 * 404 and falls back to a lookup by profile URL; a *send* given one has nothing to fall back to, and
 * the failure would land on the one action a person has just confirmed they want to happen.
 */
const chatroomId = (stored: string) => stored.split("::")[0];

/**
 * How long an in-flight send holds its lock before it counts as abandoned.
 *
 * Comfortably longer than the 20 second SendMessage timeout plus the writes either side of it, so a
 * slow send is never mistaken for a dead one, and short enough that a crashed request does not block
 * a genuine retry for long.
 */
const SEND_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Closes the gap the 24 hour check leaves open.
 *
 * That check reads rr_messages, and the outbound row is only written after HeyReach accepts the send.
 * Two requests landing together (a double click, a browser retry) both read "nothing sent yet" and
 * both send. The lock is a row in rr_app_config keyed on the conversation and the exact text, and
 * `key` is the primary key, so a plain insert is atomic: the second request's insert fails with 409
 * and it is refused before it reaches HeyReach. A lock past its expiry is from a request that died
 * mid-send; it is removed (only if unchanged, so two requests cannot both reclaim it) and taken once.
 */
async function acquireSendLock(url: string, key: string, lockKey: string): Promise<boolean> {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const insert = () =>
    fetch(`${url}/rest/v1/rr_app_config`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ key: lockKey, value: { expires_at: new Date(Date.now() + SEND_LOCK_TTL_MS).toISOString() } }),
      cache: "no-store",
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await insert();
    if (response.ok) return true;
    if (response.status !== 409) throw new Error(`Supabase rr_app_config ${response.status}`);
    if (attempt) return false;
    const held = (await db(url, key, `rr_app_config?select=value,updated_at&key=eq.${encodeURIComponent(lockKey)}&limit=1`)) as Row[];
    const lock = held[0];
    if (!lock) continue;
    const value = lock.value && typeof lock.value === "object" ? (lock.value as Row) : {};
    const expiresAt = Date.parse(text(value.expires_at));
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return false;
    await db(url, key, `rr_app_config?key=eq.${encodeURIComponent(lockKey)}&updated_at=eq.${encodeURIComponent(text(lock.updated_at))}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }
  return false;
}

async function releaseSendLock(url: string, key: string, lockKey: string) {
  await db(url, key, `rr_app_config?key=eq.${encodeURIComponent(lockKey)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => null);
}

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
  try {
    data = body ? JSON.parse(body) : null;
  } catch {
    data = body;
  }
  if (!response.ok) throw new Error(`Supabase ${path.split("?")[0]} ${response.status}`);
  return data;
}

export async function sendConversationReply(
  { url, key }: { url: string; key: string },
  input: { conversationId: string; message: string; source: string; actor: string },
): Promise<SendResult> {
  const conversationId = text(input.conversationId);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!conversationId) return { status: 400, ok: false, error: "No conversation was named." };
  if (!message) return { status: 400, ok: false, error: "There is nothing written to send." };

  const lockKey = `send_lock:${conversationId}:${createHash("sha256").update(message).digest("hex").slice(0, 32)}`;
  let lockHeld = false;
  // Cleared when HeyReach was asked and the outcome is unknown (a timeout or dropped connection): the
  // message may well have gone out, so the lock stays until it expires rather than inviting a resend.
  let releaseLock = true;
  try {
    const conversations = (await db(
      url,
      key,
      `rr_conversations?select=id,workspace_id,lead_id,heyreach_conversation_id,account_id&id=eq.${encodeURIComponent(conversationId)}&limit=1`,
    )) as Row[];
    const conversation = conversations[0];
    if (!conversation) return { status: 404, ok: false, error: "That conversation no longer exists." };
    // The lock comes before the 24 hour check, not after: a request that waited out another's send must
    // then read the row that send wrote, and a request arriving mid-send is turned away here.
    lockHeld = await acquireSendLock(url, key, lockKey);
    if (!lockHeld) {
      return { status: 409, ok: false, error: "That exact message is already being sent to this lead. Wait a moment, then refresh the thread." };
    }

    // Checked before the API key is even read: a duplicate must be refused whether or not HeyReach is
    // reachable, and reaching HeyReach is the step that cannot be undone.
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const recent = (await db(
      url,
      key,
      `rr_messages?select=id,body,sent_at&conversation_id=eq.${encodeURIComponent(conversationId)}&direction=eq.outbound&sent_at=gte.${encodeURIComponent(since)}`,
    )) as Row[];
    if (recent.some((row) => text(row.body) === message)) {
      return { status: 409, ok: false, error: "That exact message has already been sent to this lead. Change it, or leave it as it is." };
    }

    // Email Bison and lemlist conversations go out through their own platform, behind the same lock and
    // duplicate check as HeyReach: a double click or the inbox and Slack at once must not write twice.
    if (text(conversation.heyreach_conversation_id).startsWith("bison:")) {
      const sent = await sendEmailConversationReply({ url, key }, conversationId, message);
      if (sent.ok) {
        await writeAuditEvent({ url, key }, { actor: input.actor || "QC Command", action: "conversation.reply_sent", entityType: "conversation", entityId: conversationId, details: { source: input.source, status: "success", channel: "email", summary: "Email reply sent through Email Bison." } }).catch(() => undefined);
      }
      return { status: sent.status, ok: sent.ok, error: sent.error, sentAt: sent.sentAt };
    }
    // A lemlist conversation goes out through lemlist, on its own channel (email or LinkedIn).
    if (isLemlistConversationKey(conversation.heyreach_conversation_id)) {
      const sent = await sendLemlistConversationReply({ url, key }, conversationId, message);
      if (sent.ok) {
        await writeAuditEvent({ url, key }, { actor: input.actor || "QC Command", action: "conversation.reply_sent", entityType: "conversation", entityId: conversationId, details: { source: input.source, status: "success", channel: "lemlist", summary: "Reply sent through lemlist." } }).catch(() => undefined);
      }
      return { status: sent.status, ok: sent.ok, error: sent.error, sentAt: sent.sentAt };
    }

    const heyreachConversationId = chatroomId(text(conversation.heyreach_conversation_id));
    const accountId = text(conversation.account_id);
    if (!heyreachConversationId || !accountId) {
      return { status: 409, ok: false, error: "This conversation is not linked to a HeyReach chatroom and sender, so nothing can be sent from it." };
    }


    const workspaces = (await db(
      url,
      key,
      `rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(text(conversation.workspace_id))}&limit=1`,
    )) as Row[];
    const workspace = workspaces[0];
    const apiKey = text(workspace?.heyreach_api_key_ciphertext);
    if (!apiKey) {
      return { status: 409, ok: false, error: "This client has no HeyReach API key configured." };
    }

    releaseLock = false;
    const response = await fetch(`${apiBase.replace(/\/$/, "")}/inbox/SendMessage`, {
      method: "POST",
      headers: { "X-API-KEY": apiKey, accept: "application/json", "content-type": "application/json" },
      // Word for word. No template, no signature, no trailing space.
      body: JSON.stringify({
        conversationId: heyreachConversationId,
        linkedInAccountId: /^\d+$/.test(accountId) ? Number(accountId) : accountId,
        message,
        subject: SUBJECT,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    // HeyReach answered, so whether the message went out is known. On failure nothing was sent and the
    // lock can go now; on success it is held until the outbound row below is written and arms the 24
    // hour check, so a failed write cannot reopen the door to a second send.
    releaseLock = !response.ok;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // Named as "not sent" rather than "failed", because the distinction the reader needs is whether
      // the lead has it. A non-2xx from SendMessage means they do not.
      return { status: 502, ok: false, error: `HeyReach did not send the message (${response.status}). ${detail.slice(0, 300)}`.trim() };
    }

    const now = new Date().toISOString();
    await db(url, key, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([
        {
          conversation_id: conversationId,
          // The same synthetic id ingestion would mint for this text at this time, so when HeyReach
          // reports the message back on the next refresh it merges onto this row instead of appearing
          // as a second copy of the reply.
          heyreach_message_id: syntheticMessageId(now, message),
          direction: "outbound",
          body: message,
          sent_at: now,
          raw_data: { reply_radar: { source: "reply_radar_send", sent_at: now } },
        },
      ]),
    });
    releaseLock = true;
    await db(url, key, `rr_conversations?id=eq.${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_message_at: now, last_message_direction: "outbound" }),
    }).catch(() => null);

    void writeAuditEvent(
      { url, key },
      {
        actor: input.actor,
        action: "conversation.reply_sent",
        entityType: "conversation",
        entityId: conversationId,
        details: {
          workspaceId: text(conversation.workspace_id) || undefined,
          source: input.source,
          status: "success",
          // The message itself is recorded, because "a reply was sent" is not something anybody can
          // check after the fact and this is the only place it is written down as an event.
          summary: `Replied to a lead for ${text(workspace?.name) || "a client"}.`,
          characters: message.length,
          message,
        },
      },
    );

    return { status: 200, ok: true, sentAt: now, message };
  } catch (error) {
    return { status: 502, ok: false, error: error instanceof Error ? error.message : "That reply could not be sent." };
  } finally {
    if (lockHeld && releaseLock) await releaseSendLock(url, key, lockKey);
  }
}
