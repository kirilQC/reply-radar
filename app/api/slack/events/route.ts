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
import { MODEL, runAgent, type AgentEvent, type AgentResult, type Turn } from "../../../lib/assistant-run";
import { writeAuditEvent } from "../../../lib/audit-log";
import {
  addReaction,
  botIdentity,
  deleteMessage,
  postMessage,
  removeReaction,
  resolveUserNames,
  slackConfigured,
  threadPosts,
  updateMessage,
  uploadFile,
} from "../../../lib/slack";
import {
  cleanMention,
  progressLabel,
  progressText,
  threadToTurns,
  toSlackText,
  truncateForSlack,
  verifySlackSignature,
} from "../../../../shared/slack-agent.mjs";
import { briefEditIsSafe } from "../../../../shared/brief-reply.mjs";
import { findBriefThread, writeBriefReply, updateStoredBody, type BriefThread } from "../../../lib/brief-reply";

/** Same ceiling as the MCP route: the agent's tool budget is tuned to answer inside three hundred seconds. */
export const maxDuration = 300;

type Row = Record<string, unknown>;

const asObject = (value: unknown): Row => (value && typeof value === "object" ? (value as Row) : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The question actually asked — the last human turn — for the Slack bot log, whether it came as text or blocks. */
function lastUserText(messages: Turn[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== "user") continue;
    const content = messages[i].content;
    if (typeof content === "string") return content;
    const block = content.find((entry) => entry.type === "text");
    return typeof block?.text === "string" ? block.text : "";
  }
  return "";
}

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

/**
 * How often the progress message ticks over on its own, with no tool event to prompt it.
 *
 * A tool call updates the message; the long silences are between tools and — the failure this fixes —
 * after the last tool, while the model composes the answer. That final stretch can run fifteen seconds or
 * more with the list frozen on a wall of ticks, which reads as a crash. A five-second heartbeat rewrites
 * the message with the running time so there is always something moving, and it is far enough under
 * `chat.update`'s rate limit to never be the thing that trips it.
 */
const HEARTBEAT_MS = 5_000;

/** The emoji QC Bot wears on the asking message while it works; taken off once the answer is posted. */
const WORKING_REACTION = "eyes";
/** The emoji left on the asking message once the answer is out, so the thread reads as answered at a glance. */
const DONE_REACTION = "heavy_check_mark";

/**
 * The whole answer, from a built conversation to a posted reply, shared by both ways in: a fresh @-mention
 * and a follow-up reply in a thread the bot is already part of.
 *
 * `reactTs` is the message the person just sent. :eyes: goes on it the moment work starts and comes off in
 * the `finally`, so the reaction stays a truthful "working / done" even when the answer turns out to be an
 * error. Runs in `after`, so a throw here cannot fail the request — but it can leave the asker staring at
 * nothing, so every exit posts something.
 */
async function runAndReply(opts: {
  channel: string;
  threadTs: string;
  reactTs: string;
  messages: Turn[];
  askedBy: string;
  surface: "mention" | "dm" | "thread";
}): Promise<void> {
  const { channel, threadTs, reactTs, messages, askedBy, surface } = opts;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await postMessage(channel, "I can't reach the model right now — `ANTHROPIC_API_KEY` is not set.", threadTs).catch(() => {});
    return;
  }

  // :eyes: on the asking message the instant work begins, so the room sees the bot picked it up before any
  // text is posted. Removed in the `finally` below whether the answer succeeds or fails.
  if (reactTs) await addReaction(channel, reactTs, WORKING_REACTION).catch(() => {});

  try {
    // One reply, posted now and rewritten as the answer forms. If the placeholder cannot be posted at all,
    // `statusTs` stays empty and the answer is posted fresh at the end instead — the feature degrades to
    // the old post-once behaviour rather than losing the answer.
    let statusTs = "";
    try {
      statusTs = await postMessage(channel, ":mag: _On it — Searching the Reply Radar…_", threadTs);
    } catch {
      /* posting failed; fall back to a single post at the end */
    }

    // Edits are chained so they apply in the order they were queued: a late progress edit can never land
    // after the final answer and overwrite it, because the answer is the last link added to the chain.
    const steps: Step[] = [];
    const startedAt = Date.now();
    let chain: Promise<void> = Promise.resolve();
    let lastEditAt = 0;
    const queueEdit = (text: string) => {
      if (!statusTs) return;
      chain = chain.then(() => updateMessage(channel, statusTs, text).catch(() => {}));
    };
    // The progress message, always stamped with how long the run has been going so a heartbeat edit and a
    // tool edit differ even when the step list has not changed.
    const render = () => progressText(steps, { elapsedMs: Date.now() - startedAt });

    // A file a tool produced — a HeyReach CSV export, in practice. Held until the answer is delivered, then
    // uploaded into the same thread, so the person who asked for a list gets the list and not just its
    // description. The token stream carries nothing a Slack reader can use and is ignored.
    const files: Array<{ name: string; content: string }> = [];
    // The agent's tool lifecycle, turned into ticks on the progress message.
    const emit = (agentEvent: AgentEvent) => {
      if (agentEvent.type === "file") {
        files.push({ name: agentEvent.name, content: agentEvent.content });
        return;
      }
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
      queueEdit(render());
    };

    // The heartbeat: while the run is alive, keep the message moving even when no tool event has fired —
    // the long tail is the model composing its answer with the tool list already complete. Only fires when
    // a full beat has passed since the last edit, so it never races a burst of tool ticks.
    const heartbeat = statusTs
      ? setInterval(() => {
          if (Date.now() - lastEditAt < HEARTBEAT_MS) return;
          lastEditAt = Date.now();
          queueEdit(render());
        }, HEARTBEAT_MS)
      : null;

    // The finished answer: the spent progress message is deleted and the answer is posted as its own reply,
    // so the thread is left with the answer alone rather than a wall of ticks with the answer crammed on the
    // end. Posting fresh also sidesteps the failure the in-place edit used to hit — a long run updates the
    // one status message dozens of times, and Slack rate-limits repeated updates to a single message, so the
    // answer's own edit could be refused and silently lost. A new `ts` is not subject to that limit.
    const deliver = async (text: string) => {
      if (heartbeat) clearInterval(heartbeat);
      // Drain any progress edits still queued, then take the progress message down before the answer goes up.
      await chain.catch(() => {});
      if (statusTs) await deleteMessage(channel, statusTs).catch(() => {});
      await postMessage(channel, text, threadTs).catch(() => {});
    };

    // One row per run in the Slack bot log (rr_audit_log, actor slack_bot), read back by the AI section's
    // "Slack bot log" view. Written for every outcome — answered, ran out, errored — so the log is a true
    // record of what the team asked and what it cost, not only the successes. It never throws (the writer
    // swallows its own failures), so it cannot turn a delivered answer into a crash.
    const logRun = async (outcome: string, result: AgentResult | null, errorText?: string) => {
      const credential = supabaseCredentials();
      if (!credential) return;
      await writeAuditEvent(credential, {
        actor: "slack_bot",
        action: outcome === "error" ? "slack.failed" : "slack.answered",
        entityId: askedBy || undefined,
        details: {
          surface,
          channel,
          askedBy,
          question: lastUserText(messages).slice(0, 2000),
          outcome,
          durationMs: Date.now() - startedAt,
          toolCount: result ? result.steps.length : steps.length,
          inputTokens: result?.usage.inputTokens ?? 0,
          outputTokens: result?.usage.outputTokens ?? 0,
          model: MODEL,
          ...(errorText ? { error: errorText.slice(0, 500) } : {}),
        },
      });
    };

    // Tell the agent who it is talking to (so a filed support ticket is attributed) and, in a DM, that this
    // is a private 1:1 where it is that person's own Reply Radar assistant. If a support owner is configured,
    // hand it the mention token so "Kiril will look into it" actually pings him.
    const askerName = askedBy ? (await resolveUserNames([askedBy]).catch(() => new Map<string, string>())).get(askedBy) || "" : "";
    const supportOwner = (process.env.SUPPORT_OWNER_SLACK_ID || "").trim();
    const extraParts: string[] = [];
    extraParts.push(`You are talking to ${askerName || "a QC team member"}${askedBy ? ` (Slack user <@${askedBy}>)` : ""}. If you file a support ticket, record submittedBy as their name.`);
    if (surface === "dm") extraParts.push("This is a private, one-to-one direct message: you are this person's own Reply Radar assistant, with your full set of tools available. Answer for them alone — there is no channel audience reading along.");
    if (supportOwner) extraParts.push(`When you tell someone Kiril will look into a support issue, refer to him as <@${supportOwner}> so he is actually notified.`);
    const systemExtra = extraParts.join("\n");

    try {
      const result = await runAgent({ apiKey, messages, emit, systemExtra });

      if (result.maxedTurns) {
        await deliver("I ran out of research steps on that one before I could answer. Try asking something narrower.");
        await logRun("maxed_turns", result);
        return;
      }

      const cut =
        result.stopReason === "max_tokens"
          ? "\n\n_This answer hit the length limit. Ask for a narrower slice to see the rest._"
          : result.outOfTime
            ? `\n\n_Answered from ${result.steps.length} lookup${result.steps.length === 1 ? "" : "s"} before the time limit — ask for a narrower slice to let me look further._`
            : "";
      const answer = result.reply ? toSlackText(result.reply) : "I couldn't find an answer to that.";
      // The total time the whole run took, shown once on the answer — the live per-beat clock was on the
      // progress message, which is now deleted, so this is the only duration the thread keeps.
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      await deliver(`${truncateForSlack(`${answer}${cut}`)}\n\n_Answered in ${seconds}s_`);
      // Any file a tool produced (a HeyReach CSV, in practice) is uploaded into the same thread after the
      // answer, so the list the person asked for actually arrives. Best-effort: a failed upload leaves a
      // one-line note rather than breaking the answer that is already posted.
      for (const file of files) {
        await uploadFile(channel, file, { threadTs, comment: `Here's *${file.name}*.` }).catch(async (error) => {
          const why = error instanceof Error ? error.message : "the upload failed";
          await postMessage(channel, `I built *${file.name}* but couldn't attach it: ${why}`, threadTs).catch(() => {});
        });
      }
      // The answer is out; mark the asking message answered so the thread reads as done at a glance.
      if (reactTs) await addReaction(channel, reactTs, DONE_REACTION).catch(() => {});
      await logRun(result.stopReason === "max_tokens" ? "truncated" : result.outOfTime ? "out_of_time" : "success", result);
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      const detail = error instanceof Error ? error.message : "something went wrong";
      await deliver(`I hit an error answering that: ${detail}`);
      await logRun("error", null, detail);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  } finally {
    // The answer is out (or the attempt is over); take the :eyes: back off. On success a :heavy_check_mark:
    // has already been added, so the asking message is left reading as answered rather than still working.
    if (reactTs) await removeReaction(channel, reactTs, WORKING_REACTION).catch(() => {});
  }
}

/**
 * The thread as the model should read it, or a single-question fallback.
 *
 * The whole thread is read back so a follow-up carries its history; if that read comes back empty — a new
 * top-level mention, or Slack briefly unreachable — the bare question stands on its own so the bot still
 * answers. The turns are already alternating and mention-stripped by `threadToTurns`.
 */
async function conversationTurns(channel: string, threadTs: string, fallback: string): Promise<Turn[]> {
  const identity = await botIdentity();
  const turns = threadToTurns(await threadPosts(channel, threadTs), identity) as Turn[];
  if (turns.length) return turns;
  return fallback ? [{ role: "user", content: fallback }] : [];
}

/** A fresh @-mention: the classic ask, answered in-thread with the whole thread as context. */
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

  // A mention inside a thread hanging under one of our briefs or reports is a correction to that document
  // ("strike that line", "we already did this"), not a research question — hand it to the dedicated editor
  // that can actually change the original message. Only the tagging message is taken as the instruction, so
  // the team's earlier untagged chatter in the thread is never mistaken for an edit. Everything else — a
  // top-level mention, or a thread that is not one of ours — falls through to the generic agent.
  if (str(event.thread_ts)) {
    const credential = supabaseCredentials();
    if (credential) {
      const posts = await threadPosts(channel, threadTs);
      const briefThread = await findBriefThread(credential, channel, posts).catch(() => null);
      if (briefThread) {
        await replyToBrief({ channel, threadTs, reactTs: str(event.ts), briefThread, instruction: question });
        return;
      }
    }
  }

  const messages = await conversationTurns(channel, threadTs, question);
  if (!messages.length) return;
  await runAndReply({ channel, threadTs, reactTs: str(event.ts), messages, askedBy: str(event.user), surface: "mention" });
}

/**
 * A tagged reply in the thread under a brief or report QC Bot posted — the correct-the-document path.
 *
 * This is the reason the feature exists: a teammate under a morning brief or End-of-Week report who @-tags
 * the bot is almost never asking a research question, they are fixing the document ("we already did this",
 * "take that line out"). The generic agent cannot touch the message it is being asked to change, so this one
 * call returns both the reply to post and, when the reply asked for it, the whole edited body — which is
 * pushed over the original message only after `briefEditIsSafe` clears it, because the one failure this must
 * never have is a reply quietly replacing a page-long brief with a sentence.
 *
 * Only the message that tagged the bot is treated as the instruction — the team's other, untagged chatter in
 * the same thread is deliberately ignored, so casual back-and-forth is never mistaken for an edit. The stored
 * body is refreshed best-effort after a safe edit so the next brief reads the struck-through version.
 */
async function replyToBrief(opts: {
  channel: string;
  threadTs: string;
  reactTs: string;
  briefThread: BriefThread;
  instruction: string;
}): Promise<void> {
  const { channel, threadTs, reactTs, briefThread, instruction } = opts;

  // Only the message that tagged the bot is the correction — the team's other thread chatter is not.
  const replies = [cleanMention(instruction)].filter(Boolean);
  if (!replies.length) return;

  if (reactTs) await addReaction(channel, reactTs, WORKING_REACTION).catch(() => {});
  try {
    const { reply, updatedBody } = await writeBriefReply(briefThread.automation, briefThread.body, replies);

    // Only edit when the model returned a body and the guard clears it as a real change rather than a wipe.
    let edited = false;
    if (updatedBody && briefEditIsSafe(briefThread.body, updatedBody)) {
      await updateMessage(channel, briefThread.bodyTs, updatedBody).catch(() => {});
      const credential = supabaseCredentials();
      if (credential) await updateStoredBody(credential, channel, briefThread.bodyTs, updatedBody);
      edited = true;
    }

    // When the edit itself is the answer — a strike or a reword the person asked for — the changed message is
    // the confirmation, so a checkmark on the ask is all that is wanted and a "Got it, done" reply would just
    // be noise in the thread. A reply that changed nothing (a question, or an edit we could not safely apply)
    // still gets its answer posted.
    if (reactTs) await addReaction(channel, reactTs, DONE_REACTION).catch(() => {});
    if (edited) return;
    const text = reply.trim() || "Done.";
    await postMessage(channel, toSlackText(text), threadTs).catch(() => {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : "something went wrong";
    await postMessage(channel, `I hit an error on that: ${detail}`, threadTs).catch(() => {});
  } finally {
    if (reactTs) await removeReaction(channel, reactTs, WORKING_REACTION).catch(() => {});
  }
}

/**
 * Whether a `message` event is a human writing to the bot in a DM.
 *
 * A direct message arrives as a `message` event with `channel_type: "im"`. In a one-to-one DM there is no
 * one else to talk to, so there is no @-mention to wait for — every human message is for the bot, and it acts
 * as that person's private Reply Radar assistant. The subtype filter keeps out the bot's own posts, edits and
 * the "you were added" system messages. Threaded DM replies are folded in as history by `conversationTurns`,
 * so claiming the top-level message answers the whole exchange.
 */
function isDirectMessage(event: Row): boolean {
  if (event.bot_id || str(event.subtype)) return false;
  if (str(event.channel_type) !== "im") return false;
  const threadTs = str(event.thread_ts);
  return !threadTs || threadTs === str(event.ts);
}

/** A DM to the bot: answered in the DM, with the message itself as the question. */
async function answerDirectMessage(event: Row): Promise<void> {
  const channel = str(event.channel);
  if (!channel) return;
  // A DM can still be @-mentioned; strip it if so, otherwise take the whole message as the question.
  const question = cleanMention(str(event.text));
  if (!question) return;
  const threadTs = str(event.ts);
  const messages = await conversationTurns(channel, threadTs, question);
  if (!messages.length) return;
  await runAndReply({ channel, threadTs, reactTs: str(event.ts), messages, askedBy: str(event.user), surface: "dm" });
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
    // Two ways in: an @-mention in a channel (the ONLY channel trigger — the bot stays silent on every
    // untagged message so the team can talk in a thread without it butting in), and a direct message to the
    // bot (a private 1:1, where every message is for it and no tag is needed). Both are claimed by event id
    // first so a Slack redelivery cannot answer twice, and both run after the 200 so the three-second
    // deadline is met. A mention is never a message the bot itself posted (that would loop); the DM gate is
    // `isDirectMessage`. Slack delivers a threaded @-mention as an app_mention too, so tagging the bot inside
    // a thread still reaches `answerMention`.
    const mention = event.type === "app_mention" && !event.bot_id;
    const directMessage = event.type === "message" && isDirectMessage(event);
    if (mention || directMessage) {
      const claimed = await claimEvent(str(payload.event_id));
      if (claimed && slackConfigured()) {
        const answer = mention ? answerMention : answerDirectMessage;
        after(() => answer(event));
      }
    }
  }

  // Everything Slack sends gets a prompt 200, so it never retries a delivery we have already accepted.
  return new Response("", { status: 200 });
}
