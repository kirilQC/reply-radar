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
import { sendConversationReply } from "../../../lib/conversation-send";

type Row = Record<string, unknown>;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as Row;

  // The gate. Not a boolean, because `true` is what a half-written call sends by accident and what a
  // default value in a form library supplies; a literal nobody types unless they meant this route.
  if (body.confirm !== "send") {
    return NextResponse.json(
      { ok: false, error: "A reply is only sent when somebody presses the confirm button." },
      { status: 400 },
    );
  }
  // Everything past the gate, the guards included, is shared with the Slack reply alert.
  const { status, ...result } = await sendConversationReply(
    { url, key },
    {
      conversationId: typeof body.conversationId === "string" ? body.conversationId : "",
      message: typeof body.message === "string" ? body.message : "",
      source: "inbox_composer",
      actor: "User",
    },
  );
  return NextResponse.json(result, { status });
}
