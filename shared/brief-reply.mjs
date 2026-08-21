// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of "reply to a brief or report in its own thread": the prompt the reply is written to, the
 * pack it is written from, and the parse of what comes back. No I/O, so `tests/brief-reply.test.mjs` drives
 * it directly — which matters, because the one thing that can go badly wrong here is a bad edit silently
 * wiping the brief the whole team reads, and the parse and its guards are what stop that.
 *
 * ── Why this is not the research agent ───────────────────────────────────────────────────────────
 * A teammate replying under a brief is almost never asking a research question; they are correcting the
 * brief — "we already did this", "take that line out", "add the meeting we booked". That is a single,
 * bounded edit of a document the model was handed in full, not a thirty-round tool loop, and running it
 * through the research agent would give the model tools it does not need and no way to touch the message
 * it is being asked to change. So this is one call: read the post, read the reply, answer, and hand back
 * the edited post when one is warranted.
 *
 * ── Why the model returns the whole document, not a diff ──────────────────────────────────────────
 * Slack's edit replaces the whole message, so the safe unit to reason about is the whole message. A diff
 * would have to be applied here, and an off-by-one in that application is the exact catastrophe this
 * feature must not have. Handing back the complete edited body and comparing it against the original — see
 * `briefEditIsSafe` — keeps the one dangerous operation (replace the message) downstream of a check that
 * the replacement is not a wipe.
 */

/** The automations whose threads this handler answers, and how each is allowed to be edited. */
export const MORNING_BRIEF = "morning_brief";
export const EOW_REPORT = "eow_report";

/**
 * The instructions the in-thread reply is written to, branched by which automation posted the thread.
 *
 * All three share the same contract — answer briefly, return strict JSON, never invent — and differ only in
 * what an edit means. A morning brief is the team's internal working list, so an edit is a strikethrough of
 * an item the team says is done and nothing more; an End-of-Week report is a client-ready email, so an edit
 * is a reworded email in the same clean style; anything else is reply-only, because there is nothing there a
 * one-line correction should be rewriting.
 *
 * @param {string} automation
 * @returns {string}
 */
export function briefReplySystemPrompt(automation) {
  const shared = `You are QC Bot, replying to a teammate in the Slack thread under a message you posted earlier for one client of a B2B outbound growth agency. You are given the exact message you posted and the teammate's reply to it.

Answer the reply directly in one or two short sentences, first person, warm and plain. Slack mrkdwn only: *bold* with single asterisks, \`-\` for bullets, no headings, no double asterisks, no emoji, no @ mentions, no em or en dashes.

Return strict JSON and nothing else, no code fence, no prose around it:
{"reply": "<what to post back in the thread>", "updatedBody": <the full edited message as a string, or null if you are changing nothing>}

Rules that protect the message:
- "updatedBody" must be the COMPLETE message, identical to the one you were given except for the specific change the reply asks for. Never return a fragment, never summarise it, never drop sections.
- Only edit when the reply clearly asks you to. A question, a thank-you, or a comment that asks for no change gets "updatedBody": null and just an answer in "reply".
- Never invent facts, figures, names or campaigns. You may only rearrange, strike, reword or remove text that is already there, or add exactly what the teammate told you to add.`;

  if (automation === MORNING_BRIEF) {
    return `${shared}

This message is a morning brief: the team's own internal working list of what to do for this client.
- When the reply says an item is done, handled, already sent, or no longer needed, strike that whole item through. Wrap the item's task text, and every sub-bullet beneath it, in ~tildes~ (Slack strikethrough), so the entire item reads as struck with nothing left in plain text.
- If the item begins with an owner mention such as <@U123ABC> (usually followed by the word "to"), remove that mention and the "to", because a finished item has no owner, then strike the rest. A Slack mention pill cannot be struck through, so leaving it in is exactly what makes an item look half-struck. Keep the list number in place.
- Strike only that item. Do not delete the whole line, do not reorder anything, do not touch any other line, and do not touch the section headings.
- If you cannot tell which item they mean, do not guess and do not edit: ask which one in "reply".
- Keep "reply" to a short confirmation of what you struck.`;
  }

  if (automation === EOW_REPORT) {
    return `${shared}

This message is an End-of-Week report: a formal, client-ready email the client will read.
- When the reply asks you to add, remove, or reword something, produce the full edited report in "updatedBody", keeping the same clean, formal, client-ready style: plain professional English, first person plural ("we"), *bold* section headings, \`-\` bullets, no emoji, no @ mentions, no em or en dashes. Change only what was asked and leave everything else exactly as it was.
- Keep the closing sign-off line exactly as it is unless the reply asks you to change it.`;
  }

  return `${shared}

This message is not one you should be rewriting from a thread reply, so always return "updatedBody": null and simply answer the teammate's reply.`;
}

/**
 * The message you posted and the replies under it, assembled into one prompt.
 *
 * @param {{ body: string; replies: string[] }} inputs
 * @returns {string}
 */
export function briefReplyUserContent(inputs) {
  const body = String(inputs?.body ?? "").trim();
  const replies = (Array.isArray(inputs?.replies) ? inputs.replies : [])
    .map((reply) => String(reply ?? "").trim())
    .filter(Boolean);
  const repliesText = replies.length
    ? replies.map((reply) => `- ${reply}`).join("\n")
    : "(no reply text could be read)";
  return [
    `# The message you posted\n\n${body}`,
    `# The teammate's reply, respond to this\n\n${repliesText}`,
    `Respond now. Return only the JSON object.`,
  ].join("\n\n---\n\n");
}

/**
 * The model's answer, pulled out of whatever it wrapped the JSON in.
 *
 * The prompt asks for a bare JSON object, but a model will occasionally fence it or add a line before it, so
 * the first `{` to the last `}` is taken and parsed. A body that will not parse is not an error worth failing
 * on — the reply text is still useful — so the whole thing is treated as the reply with no edit. `updatedBody`
 * is only honoured when it is a non-empty string; anything else (null, a number, "") means no edit.
 *
 * @param {string} text
 * @returns {{ reply: string; updatedBody: string | null }}
 */
export function parseBriefReplyOutput(text) {
  const raw = String(text ?? "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const reply = typeof parsed?.reply === "string" ? parsed.reply.trim() : "";
      const updated = typeof parsed?.updatedBody === "string" && parsed.updatedBody.trim() ? parsed.updatedBody : null;
      if (reply || updated) return { reply, updatedBody: updated };
    } catch {
      // Fall through to treating the whole thing as the reply.
    }
  }
  return { reply: raw, updatedBody: null };
}

/**
 * Whether an edit the model proposed is safe to push over the message the team reads.
 *
 * The one failure this feature must never have is a reply quietly replacing a page-long brief with a
 * sentence, so an edit that is not really an edit (identical to the original once trimmed) is refused, and so
 * is one that has lost more than a third of the message's length — a real correction strikes a line or drops
 * a bullet, it does not halve the document. The strikethrough case only ever adds characters, so this bites
 * only the genuinely dangerous shrink.
 *
 * @param {string} original
 * @param {string | null} updated
 * @returns {boolean}
 */
export function briefEditIsSafe(original, updated) {
  if (typeof updated !== "string") return false;
  const before = String(original ?? "").trim();
  const after = updated.trim();
  if (!after) return false;
  if (after === before) return false;
  if (before.length && after.length < before.length * 0.66) return false;
  return true;
}
