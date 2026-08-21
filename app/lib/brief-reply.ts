// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The I/O half of "reply to a brief or report in its own thread": find the stored message the thread hangs
 * under, ask the model for a reply and an edit, and write the edited body back to the row so the next brief
 * reads the struck-through version.
 *
 * ── Why this exists next to the generic assistant ────────────────────────────────────────────────
 * A teammate replying under a brief is not asking a research question, they are correcting a document the
 * bot handed them in full: "we already did this", "take that line out", "add the meeting we booked". The
 * research agent has no way to touch the message it is being asked to change, so this is the path that can:
 * one Anthropic call that returns both the reply to post and, when warranted, the whole edited body — and a
 * `chat.update` over the original message downstream of `briefEditIsSafe`, which is the only thing standing
 * between a one-line correction and a wiped brief.
 *
 * The pure half — the prompt, the parse, and the safety guard — lives in `shared/brief-reply.mjs` so the
 * tests can drive it without Slack or Anthropic.
 */

import {
  briefReplySystemPrompt,
  briefReplyUserContent,
  parseBriefReplyOutput,
} from "../../shared/brief-reply.mjs";
import { writeBrief, BRIEF_MODEL } from "./morning-brief-run";
import type { ThreadPost } from "./slack";

type Credential = { url: string; key: string };

/** The stored brief or report a thread is hanging under, matched by the message people actually read. */
export type BriefThread = {
  automation: string;
  bodyTs: string;
  body: string;
  workspaceId: string;
};

type Row = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The stored brief/report the thread is a reply to, or null if this thread is not one of ours.
 *
 * A brief posts a one-line header (which becomes the thread root) and then the body as a reply under it, and
 * the body's `ts` is what `rr_slack_briefs.slack_message_ts` stores — so the thread the human replied in
 * contains, somewhere in its posts, the ts of a row we wrote. Recent success rows for this channel are read
 * and matched against the thread's post ts set here, client-side, rather than with a Postgres `in.()` over
 * the ts list: the ts values carry dots and would need encoding, and a fifty-row read is cheap. The newest
 * match wins, because a channel accumulates many briefs and the one being replied to is the recent one.
 */
export async function findBriefThread(
  credential: Credential,
  channel: string,
  posts: ThreadPost[],
): Promise<BriefThread | null> {
  if (!channel || !posts.length) return null;
  const tsInThread = new Set(posts.map((post) => post.ts).filter(Boolean));
  if (!tsInThread.size) return null;

  const query =
    `rr_slack_briefs?select=automation,slack_message_ts,body,workspace_id,created_at` +
    `&slack_channel_id=eq.${encodeURIComponent(channel)}` +
    `&status=eq.success&slack_message_ts=not.is.null` +
    `&order=created_at.desc&limit=50`;

  let rows: Row[] = [];
  try {
    const response = await fetch(`${credential.url}/rest/v1/${query}`, {
      headers: { apikey: credential.key, Authorization: `Bearer ${credential.key}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    const parsed = await response.json().catch(() => []);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    return null;
  }

  for (const row of rows) {
    const bodyTs = str(row.slack_message_ts);
    if (bodyTs && tsInThread.has(bodyTs)) {
      return {
        automation: str(row.automation),
        bodyTs,
        body: str(row.body),
        workspaceId: str(row.workspace_id),
      };
    }
  }
  return null;
}

/**
 * One Anthropic call: the reply to post in the thread, and the full edited body when the reply asked for one.
 *
 * The system prompt branches on which automation posted the thread (a morning brief is struck through, an EOW
 * report is reworded, anything else is reply-only), and the reply always comes back as strict JSON that
 * `parseBriefReplyOutput` pulls apart. A body that will not parse is treated as the whole reply with no edit,
 * so a malformed answer degrades to a plain reply rather than an error.
 */
export async function writeBriefReply(
  automation: string,
  body: string,
  replies: string[],
): Promise<{ reply: string; updatedBody: string | null }> {
  const systemPrompt = briefReplySystemPrompt(automation);
  const userContent = briefReplyUserContent({ body, replies });
  const raw = await writeBrief(systemPrompt, userContent, BRIEF_MODEL);
  return parseBriefReplyOutput(raw);
}

/**
 * Push the edited body back onto the stored row, so the next brief reads the struck-through version.
 *
 * Best-effort by design: the visible edit is the `chat.update` over the Slack message the team reads, and
 * that has already happened by the time this runs. This only keeps `rr_slack_briefs.body` in step so that
 * `gatherPriorBriefs` shows the model the corrected brief next time, and a failed write here should never
 * turn a delivered reply into an error. Matched on the body ts and channel, the same pair the row is found by.
 */
export async function updateStoredBody(
  credential: Credential,
  channel: string,
  bodyTs: string,
  updatedBody: string,
): Promise<void> {
  if (!channel || !bodyTs) return;
  const query =
    `rr_slack_briefs?slack_channel_id=eq.${encodeURIComponent(channel)}` +
    `&slack_message_ts=eq.${encodeURIComponent(bodyTs)}`;
  try {
    await fetch(`${credential.url}/rest/v1/${query}`, {
      method: "PATCH",
      headers: {
        apikey: credential.key,
        Authorization: `Bearer ${credential.key}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ body: updatedBody }),
      cache: "no-store",
    });
  } catch {
    /* best-effort: the Slack message is already edited, the stored copy catching up is a nicety */
  }
}
