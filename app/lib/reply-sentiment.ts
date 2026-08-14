// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { writeAuditEvent } from "./audit-log";
import { mergeMessageRadar } from "./message-radar";

type SupabaseConfig = { url: string; key: string };
type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

/**
 * The classifier's one job is to be trusted, and the way it lost that trust was by calling almost
 * everything positive: a friendly "thanks for reaching out" reads as engagement if you are only asked
 * whether the lead sounds interested. So the prompt no longer asks that. It asks whether the reply
 * contains a forward step the lead themselves offered, which is a fact you can point at, and it makes
 * NEUTRAL the answer whenever there is nothing to point at. The worked examples exist because the
 * boundary cases are the whole problem — "sounds interesting" and "send me some info" have to be shown
 * as neutral or they get read as wins.
 */
const DEFAULT_SENTIMENT_PROMPT = `You are classifying the lead's LATEST inbound reply in a LinkedIn conversation run by an outbound growth agency. The agency messaged the lead first — the lead is replying to a cold pitch, so ordinary politeness costs them nothing and means nothing.

Your default answer is NEUTRAL. Most replies to cold outreach are neutral. Move off NEUTRAL only when the reply gives you something concrete to point at: real forward movement (positive) or real refusal (negative). A reply being warm, long, or on-topic is not interest.

STEP 1 — Does the latest reply contain a forward step the lead is offering or accepting? A forward step is one of:
- accepting or proposing a meeting, call, or demo, or offering their availability
- giving an email, phone number, or calendar link so things can continue
- asking a question whose answer only matters to someone weighing a purchase (price, scope, timeline, how it would work for their team, contract terms, proof or case studies)
- naming a specific colleague to bring in, or saying they are forwarding it to a named person or team who owns the decision
- asking us to send the deck, the pricing, the trial, the details — and saying who it is for or what they want to see
- committing to a dated next step of their own ("I'll review this weekend and come back Monday")
If yes, the answer is POSITIVE. If no, POSITIVE is not available to you no matter how enthusiastic the wording is.

STEP 2 — Is the lead refusing or closing the conversation? Signals:
- declining outright ("not interested", "no thanks", "we'll pass")
- asking to stop, be removed, or be unsubscribed, or telling us not to message again
- annoyance, hostility, sarcasm, or calling it spam
- saying they already have this handled or have a provider and are not looking
- saying it is not relevant to them or their company at all
- wrong person with nobody named to redirect to
- saying no to the specific ask with nothing offered instead
If yes, the answer is NEGATIVE.

STEP 3 — Everything else is NEUTRAL: friendly but empty, curious but uncommitted, or deferred without a date.

CALIBRATION — real shapes of reply, and the correct label for each.

POSITIVE:
- "Sure, Thursday afternoon works. Send an invite." -> positive
- "Happy to chat — jane@acme.com is best for me." -> positive
- "What does pricing look like for a team of 40?" -> positive
- "This is timely. How quickly could you start?" -> positive
- "Not me, but Priya runs demand gen — I'll introduce you." -> positive
- "Send the deck and I'll take it to our ops lead this week." -> positive
- "Yes let's do it, here's my calendar link." -> positive

NEUTRAL — note how warm several of these sound:
- "Thanks for reaching out!" -> neutral
- "Interesting, thanks for sharing." -> neutral
- "Sounds interesting." -> neutral (interest with nothing attached to it is still neutral)
- "Cool — what do you guys do exactly?" -> neutral (asking who we are, not how it would work for them)
- "Let me think about it." -> neutral
- "Circle back with me in Q3." -> neutral
- "We're heads down on a launch, maybe later in the year." -> neutral
- "I'll keep you in mind if something comes up." -> neutral (a polite shelf: no refusal, no step)
- "Appreciate the note, I'll take a look." -> neutral (nothing dated, nothing committed)
- "Who is this?" -> neutral
- "I'm out of office until the 14th with limited access." -> neutral
- "Ok" / "Got it" / "Noted" / "Thanks" / a thumbs up -> neutral
- "Nice to connect!" / "Thanks for the add" -> neutral
- "Good luck with it." -> neutral
- "Not the right time for us." -> neutral (timing, not a rejection of the idea)
- "Send me some info I guess." -> neutral (grudging, no owner, no date — this is not a request for the deck)
- A long friendly reply about their own company that never engages with the offer -> neutral

NEGATIVE:
- "Not interested, thanks." -> negative
- "Please remove me from your list." -> negative
- "Stop messaging me." -> negative
- "We already work with someone for this." -> negative
- "This isn't relevant to us." -> negative
- "I get twenty of these a day." -> negative
- "Do you send this to everyone?" -> negative (challenging the outreach itself)
- "No." -> negative
- "I don't handle this." -> negative (wrong person, nobody named)
- "Hard pass." -> negative

TIE-BREAKERS:
- Enthusiastic adjectives with no commitment attached are NEUTRAL. "Love this", "very cool", "great idea" move nothing forward on their own.
- A question is positive only if answering it requires specifics a buyer would need. Questions about who we are, how we found them, or what we sell in general are NEUTRAL.
- "Send me info" is NEUTRAL unless they say who it is for, when they will read it, or what they want to see.
- A soft no with a door left open ("not now", "revisit in six months") is NEUTRAL. A no with no door ("we're not doing this") is NEGATIVE.
- Label the latest inbound reply only. Use earlier messages to understand what it is answering, nothing more. A lead who was warm three messages ago and now writes "let's park this" is NEUTRAL now.
- Automated bounces, out-of-office replies, and "connection accepted" non-messages are NEUTRAL.
- If you are torn between two labels, choose NEUTRAL. Overcalling positive is the costliest mistake here, because it puts a lead who is going nowhere at the top of someone's follow-up list.

Reply with exactly one word: positive, neutral, or negative.`;

async function getConfiguredPrompt(config: SupabaseConfig, workspaceId?: string): Promise<string> {
  try {
    // Try workspace's custom_system_prompt first
    if (workspaceId) {
      const response = await fetch(
        `${config.url}/rest/v1/rr_workspaces?select=custom_system_prompt&slug=eq.${encodeURIComponent(workspaceId)}&limit=1`,
        { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, cache: "no-store" },
      );
      if (response.ok) {
        const rows = await response.json().catch(() => []);
        if (Array.isArray(rows) && rows.length && rows[0].custom_system_prompt) {
          // Workspace has a custom prompt — prepend the sentiment classification rules
          return `${DEFAULT_SENTIMENT_PROMPT}\n\nAdditional client-specific context:\n${String(rows[0].custom_system_prompt)}`;
        }
      }
    }
  } catch { /* use default */ }
  return DEFAULT_SENTIMENT_PROMPT;
}

export async function classifyLatestReply(
  config: SupabaseConfig,
  conversationId: string,
  workspaceId?: string,
  meta?: { leadName?: string; workspaceName?: string; force?: boolean },
) {
  if (!process.env.ANTHROPIC_API_KEY || !conversationId) {
    console.log(`[sentiment] Skipping: API key present=${!!process.env.ANTHROPIC_API_KEY}, conversationId=${conversationId}`);
    return;
  }
  const headers = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "content-type": "application/json",
  };
  const response = await fetch(
    `${config.url}/rest/v1/rr_messages?select=id,direction,body,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}&order=sent_at.desc&limit=20`,
    { headers, cache: "no-store" },
  );
  if (!response.ok) { console.log(`[sentiment] Messages fetch failed: ${response.status}`); return; }
  const rows = ((await response.json()) as Row[]).reverse();
  const latestInbound = [...rows].reverse().find((row) => row.direction === "inbound");
  if (!latestInbound?.id) { console.log(`[sentiment] No inbound message found for ${conversationId}`); return; }
  const latestRaw = object(latestInbound.raw_data);
  const latestRadar = object(latestRaw.reply_radar);
  // A stored sentiment is normally the answer and costs nothing to reuse. It stops being the answer
  // when the rules that produced it have changed, which is what force is for: everything scored under
  // an older version of the prompt keeps that verdict forever otherwise.
  if (!meta?.force && ["positive", "neutral", "negative"].includes(String(latestRadar.sentiment).toLowerCase())) { console.log(`[sentiment] Already classified as ${latestRadar.sentiment} for ${conversationId}`); return; }

  const systemPrompt = await getConfiguredPrompt(config, workspaceId);
  const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
  const DEPRECATED = new Set(["claude-3-5-haiku-latest", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"]);
  const configuredModel = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const model = DEPRECATED.has(configuredModel) ? DEFAULT_MODEL : configuredModel;
  const userContent = rows.map((row) => `${row.direction}: ${String(row.body ?? "")}`).join("\n");
  const startTime = Date.now();

  const provider = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 10,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(8_000),
  });

  const durationMs = Date.now() - startTime;
  const payload = provider.ok ? await provider.json().catch(() => ({})) : {};
  const inputTokens = payload?.usage?.input_tokens ?? 0;
  const outputTokens = payload?.usage?.output_tokens ?? 0;

  if (!provider.ok) {
    void writeAuditEvent(config, {
      actor: "anthropic",
      action: "sentiment_analysis",
      entityType: "conversation",
      entityId: conversationId,
      details: {
        status: "error",
        model,
        httpStatus: provider.status,
        durationMs,
        reason: "sentiment_classification",
        workspaceId: workspaceId ?? null,
        workspaceName: meta?.workspaceName ?? null,
        leadName: meta?.leadName ?? null,
      },
    });
    return;
  }

  const sentiment = String(
    payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "",
  )
    .trim()
    .toLowerCase();

  if (!["positive", "neutral", "negative"].includes(sentiment)) {
    void writeAuditEvent(config, {
      actor: "anthropic",
      action: "sentiment_analysis",
      entityType: "conversation",
      entityId: conversationId,
      details: {
        status: "warning",
        model,
        inputTokens,
        outputTokens,
        durationMs,
        rawOutput: sentiment,
        reason: "sentiment_classification",
        note: "Model returned unexpected value",
        workspaceId: workspaceId ?? null,
        workspaceName: meta?.workspaceName ?? null,
        leadName: meta?.leadName ?? null,
      },
    });
    return;
  }

  // Merge through the shared writer so a concurrent draft or follow-up score does not
  // get clobbered by this write (and vice versa).
  const persisted = await mergeMessageRadar(config, String(latestInbound.id), {
    sentiment,
    analyzed_at: new Date().toISOString(),
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  console.log(`[sentiment] merge message ${latestInbound.id} → ${sentiment}, persisted=${persisted}`);

  void writeAuditEvent(config, {
    actor: "anthropic",
    action: "sentiment_analysis",
    entityType: "conversation",
    entityId: conversationId,
    details: {
      status: "success",
      model,
      sentiment,
      inputTokens,
      outputTokens,
      durationMs,
      reason: "sentiment_classification",
      workspaceId: workspaceId ?? null,
      workspaceName: meta?.workspaceName ?? null,
      leadName: meta?.leadName ?? null,
    },
  });

  return sentiment;
}

export { DEFAULT_SENTIMENT_PROMPT };
