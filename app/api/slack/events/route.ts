// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Slack side of the Reply Radar assistant: @-mention QC Bot and get the same answer the MCP tab
 * gives, in the thread you asked from.
 *
 * ── Why the agent runs after the response, not before it ─────────────────────────────────────────
 * Slack demands a 200 within three seconds or it retries the delivery, and the assistant routinely
 * takes far longer than that — it is a thirty-round research loop by design. So the request is answered
 * the instant its signature checks out, and the actual work is handed to `after`, which keeps running
 * once the 200 has gone back. The reply is posted to Slack when it is ready. This is the same sixty
 * second function ceiling the MCP route lives under; the difference is only that nobody is watching a
 * stream, so the answer arrives whole or not at all.
 *
 * ── Why every request is signature-checked, and the body is read as text ─────────────────────────
 * This endpoint is public — Slack has to be able to reach it — so the only thing separating a real
 * event from a forged one is the HMAC Slack signs each request with. That hash is over the *raw* bytes
 * of the body, so the body is read as text and verified before it is parsed; parsing first and
 * re-serialising would change the bytes and make every genuine request look forged. See
 * `verifySlackSignature`.
 *
 * ── Why an events table ──────────────────────────────────────────────────────────────────────────
 * Slack redelivers an event if it does not see the 200 in time, and a redelivery that reran the agent
 * would post the same answer twice. `rr_slack_events` is claimed by `event_id` before any work starts —
 * a duplicate insert is refused by the primary key, and a refused claim means someone is already
 * answering this one, so this delivery does nothing.
 */

import { after } from "next/server";
import { runAgent, type AgentEvent } from "../../../lib/assistant-run";
import { postMessage, slackConfigured, updateMessage } from "../../../lib/slack";
import {
  cleanMention,
  progressLabel,
  progressText,
  toSlackText,
  truncateForSlack,
  verifySlackSignature,
} from "../../../../shared/slack-agent.mjs";

/** Same ceiling as the MCP route: the agent's tool budget is tuned to answer inside sixty seconds. */
export const maxDuration = 60;

type Row = Record<string, unknown>;

const asObject = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

function supabaseCredentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

/**
 * Claims one event id so exactly one delivery of it is ever worked.
 *
 * The insert is the lock: `rr_slack_events.event_id` is a primary key, so a second delivery's insert is
 * refused with a 409 and this returns false, which is the signal to do nothing. A first delivery gets a
 * 201 and the go-ahead. When the table cannot be reached at all — not configured, not migrated — it
 * fails open and returns true, because answering twice in that rare case is better than never answering.
 */
async function claimEvent(eventId: string): Promise<boolean> {
  if (!eventId) return true;
  const credential = supabaseCredentials();
  if (!credential) return true;
  try {
    const response = await fetch(`${credential.url}/rest/v1/rr_slack_events`, {
      method: "POST",
      headers: {
        apikey: credential.key,
        Authorization: `Bearer ${credential.key}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ event_id: eventId }),
      cache: "no-store",
    });
    if (response.status === 201) return true;
    if (response.status === 409) return false;
    // Any other status — a missing table, a transient error — falls open rather than dropping the event.
    return true;
  } catch {
    return true;
  }
}

/**
 * The whole answer, from question to posted reply. Runs in `after`, so a throw here cannot fail the
 * request — but it can leave the person who asked staring at nothing, so every exit posts something.
 */
/** A tool the agent has run or is running, in the order it was called, for the live progress message. */
type Step = { tool: string; label: string; status: "doing" | "ok" | "fail" };

/**
 * How long, at least, between edits of the progress message.
 *
 * `chat.update` is rate limited, and the agent can fire several tool calls in a burst; editing on every
 * one would both risk a 429 and flicker. Eight hundred milliseconds is slower than the eye needs and far
 * under the limit, and because real tool calls each carry network latency the events naturally space out
 * around it. The final answer is written outside this throttle, so nothing it says is ever dropped.
 */
const PROGRESS_THROTTLE_MS = 800;

async function answerMention(event: Row): Promise<void> {
  const channel = str(event.channel);
  // Reply in the thread the mention is in; if it was a top-level message, start a thread under it so the
  // channel is not flooded with a page-long answer.
  const threadTs = str(event.thread_ts) || str(event.ts);
  if (!channel) return;

  const question = cleanMention(str(event.text));
  if (!question) {
    await postMessage(channel, "Ask me a question in the same message you mention me — for example, _how did Cotool do this week?_", threadTs).catch(() => {});
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await postMessage(channel, "I can't reach the model right now — `ANTHROPIC_API_KEY` is not set.", threadTs).catch(() => {});
    return;
  }

  // One reply, posted now and rewritten as the answer forms. If the placeholder cannot be posted at all,
  // `statusTs` stays empty and the answer is posted fresh at the end instead — the feature degrades to
  // the old post-once behaviour rather than losing the answer.
  let statusTs = "";
  try {
    statusTs = await postMessage(channel, ":mag: _On it — reading the room…_", threadTs);
  } catch {
    /* posting failed; fall back to a single post at the end */
  }

  // Edits are chained so they apply in the order they were queued: a late progress edit can never land
  // after the final answer and overwrite it, because the answer is the last link added to the chain.
  const steps: Step[] = [];
  let chain: Promise<void> = Promise.resolve();
  let lastEditAt = 0;
  const queueEdit = (text: string) => {
    if (!statusTs) return;
    chain = chain.then(() => updateMessage(channel, statusTs, text).catch(() => {}));
  };

  // The agent's tool lifecycle, turned into ticks on the progress message. Other event kinds (the token
  // stream, files) carry nothing a Slack reader can use here and are ignored.
  const emit = (agentEvent: AgentEvent) => {
    if (!statusTs) return;
    if (agentEvent.type === "tool") {
      steps.push({ tool: agentEvent.tool, label: progressLabel(agentEvent.tool, agentEvent.input), status: "doing" });
    } else if (agentEvent.type === "tool_done") {
      const entry = [...steps].reverse().find((step) => step.tool === agentEvent.tool && step.status === "doing");
      if (entry) entry.status = agentEvent.ok ? "ok" : "fail";
    } else {
      return;
    }
    const now = Date.now();
    if (now - lastEditAt < PROGRESS_THROTTLE_MS) return;
    lastEditAt = now;
    queueEdit(progressText(steps));
  };

  // The finished answer, delivered by rewriting the progress message — or posted fresh if there was none.
  const deliver = async (text: string) => {
    if (statusTs) {
      queueEdit(text);
      await chain;
    } else {
      await postMessage(channel, text, threadTs).catch(() => {});
    }
  };

  try {
    const result = await runAgent({ apiKey, messages: [{ role: "user", content: question }], emit });

    if (result.maxedTurns) {
      await deliver("I ran out of research steps on that one before I could answer. Try asking something narrower.");
      return;
    }

    const cut =
      result.stopReason === "max_tokens"
        ? "\n\n_This answer hit the length limit. Ask for a narrower slice to see the rest._"
        : result.outOfTime
          ? `\n\n_Answered from ${result.steps.length} lookup${result.steps.length === 1 ? "" : "s"} before the time limit — ask for a narrower slice to let me look further._`
          : "";
    const answer = result.reply ? toSlackText(result.reply) : "I couldn't find an answer to that.";
    await deliver(truncateForSlack(`${answer}${cut}`));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "something went wrong";
    await deliver(`I hit an error answering that: ${detail}`);
  }
}

export async function POST(request: Request) {
  const signingSecret = str(process.env.SLACK_SIGNING_SECRET);
  if (!signingSecret) {
    // A 503 rather than a silent 200 so a misconfigured deploy is visible in Slack's own event log.
    return new Response("Slack signing secret is not configured.", { status: 503 });
  }

  const body = await request.text();
  const ok = verifySlackSignature({
    signingSecret,
    timestamp: request.headers.get("x-slack-request-timestamp") ?? "",
    body,
    signature: request.headers.get("x-slack-signature") ?? "",
  });
  if (!ok) return new Response("Signature verification failed.", { status: 401 });

  let payload: Row = {};
  try {
    payload = asObject(JSON.parse(body));
  } catch {
    return new Response("Bad request.", { status: 400 });
  }

  // Slack proves it owns the endpoint by asking us to echo a challenge back, once, when the URL is set.
  if (payload.type === "url_verification") {
    return Response.json({ challenge: str(payload.challenge) });
  }

  if (payload.type === "event_callback") {
    const event = asObject(payload.event);
    // Only mentions of the bot, and never a message the bot itself posted — the latter would loop.
    if (event.type === "app_mention" && !event.bot_id) {
      const claimed = await claimEvent(str(payload.event_id));
      if (claimed && slackConfigured()) {
        // Answered after the 200 so Slack's three-second deadline is met; the reply is posted when ready.
        after(() => answerMention(event));
      }
    }
  }

  // Everything Slack sends gets a prompt 200, so it never retries a delivery we have already accepted.
  return new Response("", { status: 200 });
}
