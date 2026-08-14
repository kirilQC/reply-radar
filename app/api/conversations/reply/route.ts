// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Sending one reply to one lead, on LinkedIn, through HeyReach.
 *
 * ── The only route in this application that says something to a stranger ─────────────────────────
 * Everything else here reads: the inbox, the analytics, the brain reader, every assistant tool. This
 * one puts words in front of a real person under a client's name, and it cannot be taken back. So it
 * is built to be difficult to trigger by accident, and the difficulty is deliberate rather than
 * incidental.
 *
 * ── What has to be true before a message leaves ──────────────────────────────────────────────────
 * 1. A person pressed a button, twice. The browser cannot reach this route without `confirm: "send"`
 *    in the body, which the page only sets on the second, separate press of a confirmation control.
 *    A stray fetch, a retried request, a prefetch or a rerender cannot satisfy it.
 * 2. The exact text is posted from the page. Nothing here generates, rewrites, tidies or appends to
 *    it — what the person read in the draft box is what LinkedIn receives, byte for byte. That is
 *    also why the draft is not re-read from the database: a cached draft regenerated between reading
 *    and pressing would send text nobody approved.
 * 3. Nothing identical has already gone out. The same body, outbound, on the same conversation,
 *    inside a day, is refused with a 409. This is the guard that actually matters, because the
 *    realistic accident is not a malicious call — it is a double click, a flaky connection retried by
 *    the browser, or somebody pressing send again because the first attempt looked like it hung.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────────────────────────
 * There is no assistant tool for this, and there must never be one. The MCP assistant's tool list
 * (`app/lib/assistant-tools.ts`) is read-only apart from proposing a pull request against the brain,
 * and sending a message is the one action where a model being usually right is not good enough. There
 * is also no bulk form: this route takes one conversation, because a loop over a list is how twenty
 * messages go out when one was meant to.
 *
 * ── Why the sent message is written to our own table ────────────────────────────────────────────
 * HeyReach will report it on the next refresh, minutes later. Between now and then the thread would
 * show nothing, which reads exactly like a failed send and invites a second press — so the reply is
 * recorded here immediately, both to show it and to arm the duplicate guard above.
 */
import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";
import { syntheticMessageId } from "../../../lib/heyreach-conversation";

type Row = Record<string, unknown>;
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

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as Row;
  const conversationId = text(body.conversationId);
  const message = typeof body.message === "string" ? body.message.trim() : "";

  // The gate. Not a boolean, because `true` is what a half-written call sends by accident and what a
  // default value in a form library supplies; a literal nobody types unless they meant this route.
  if (body.confirm !== "send") {
    return NextResponse.json(
      { ok: false, error: "A reply is only sent when somebody presses the confirm button." },
      { status: 400 },
    );
  }
  if (!conversationId) return NextResponse.json({ ok: false, error: "No conversation was named." }, { status: 400 });
  if (!message) return NextResponse.json({ ok: false, error: "There is nothing written to send." }, { status: 400 });

  try {
    const conversations = (await db(
      url,
      key,
      `rr_conversations?select=id,workspace_id,lead_id,heyreach_conversation_id,account_id&id=eq.${encodeURIComponent(conversationId)}&limit=1`,
    )) as Row[];
    const conversation = conversations[0];
    if (!conversation) return NextResponse.json({ ok: false, error: "That conversation no longer exists." }, { status: 404 });

    const heyreachConversationId = text(conversation.heyreach_conversation_id);
    const accountId = text(conversation.account_id);
    if (!heyreachConversationId || !accountId) {
      return NextResponse.json(
        { ok: false, error: "This conversation is not linked to a HeyReach chatroom and sender, so nothing can be sent from it." },
        { status: 409 },
      );
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
      return NextResponse.json(
        { ok: false, error: "That exact message has already been sent to this lead. Change it, or leave it as it is." },
        { status: 409 },
      );
    }

    const workspaces = (await db(
      url,
      key,
      `rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(text(conversation.workspace_id))}&limit=1`,
    )) as Row[];
    const workspace = workspaces[0];
    const apiKey = text(workspace?.heyreach_api_key_ciphertext);
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: "This client has no HeyReach API key configured." }, { status: 409 });
    }

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
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      // Named as "not sent" rather than "failed", because the distinction the reader needs is whether
      // the lead has it. A non-2xx from SendMessage means they do not.
      return NextResponse.json(
        { ok: false, error: `HeyReach did not send the message (${response.status}). ${detail.slice(0, 300)}`.trim() },
        { status: 502 },
      );
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
    await db(url, key, `rr_conversations?id=eq.${encodeURIComponent(conversationId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_message_at: now, last_message_direction: "outbound" }),
    }).catch(() => null);

    void writeAuditEvent(
      { url, key },
      {
        actor: "User",
        action: "conversation.reply_sent",
        entityType: "conversation",
        entityId: conversationId,
        details: {
          workspaceId: text(conversation.workspace_id) || undefined,
          source: "inbox_composer",
          status: "success",
          // The message itself is recorded, because "a reply was sent" is not something anybody can
          // check after the fact and this is the only place it is written down as an event.
          summary: `Replied to a lead for ${text(workspace?.name) || "a client"}.`,
          characters: message.length,
          message,
        },
      },
    );

    return NextResponse.json({ ok: true, sentAt: now, message });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "That reply could not be sent." },
      { status: 502 },
    );
  }
}
