/**
 * Turns a template's prompt plus a report's numbers into written copy.
 *
 * Three things come back: a headline, the executive-summary narrative for the PDF, and the message an
 * account manager sends alongside it. The CSV is not here — it is derived straight from the data and
 * needs no model.
 *
 * The route digests the report itself rather than trusting the caller to send a summary. The client
 * already holds the full report, including every hot-conversation snippet and sample reply, and
 * forwarding all of that would spend thousands of tokens on text the model does not need to write 150
 * words. Digesting here also means what the model sees is defined in one place.
 */
import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";
import { COMPOSE_SYSTEM_PROMPT } from "../../../lib/report-templates";

type Json = Record<string, unknown>;

const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const array = (value: unknown): Json[] => (Array.isArray(value) ? value.map(object) : []);
const int = (value: unknown) => (Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0);

/**
 * Compresses one client's report into the few lines the model actually needs.
 *
 * Only the leading rows of each table are kept: a summary that names the top five campaigns reads the
 * same as one that names all forty, and the tail is what makes the prompt expensive. Verbatim reply
 * bodies are left out entirely — they are evidence for the reader, not context for the writer.
 */
function digest(client: Json) {
  const summary = object(client.summary);
  const trend = array(client.trend);
  const firstHalf = trend.slice(0, Math.floor(trend.length / 2));
  const secondHalf = trend.slice(Math.floor(trend.length / 2));
  const sum = (rows: Json[]) => rows.reduce((total, row) => total + int(row.replies), 0);
  const average = (rows: Json[]) => (rows.length ? sum(rows) / rows.length : 0);

  // A direction the model can state without doing arithmetic itself, which it does unreliably.
  let trajectory = "not enough data to judge a trend";
  if (trend.length >= 4) {
    const before = average(firstHalf);
    const after = average(secondHalf);
    const change = before ? ((after - before) / before) * 100 : 0;
    trajectory =
      Math.abs(change) < 10
        ? "holding roughly steady"
        : change > 0
          ? `rising, up about ${Math.round(change)}% comparing the second half of the period to the first`
          : `falling, down about ${Math.round(Math.abs(change))}% comparing the second half of the period to the first`;
  }

  const icp = object(client.icpBuckets);

  /**
   * Live campaign state, phrased so the model cannot mistake "we could not ask" for "nothing is
   * running", and so it cannot call a worked-through campaign active. The definition is restated here
   * because the model sees only this JSON, not the code that produced it.
   */
  const status = object(client.campaignStatus);
  const campaign = (row: Json) => ({
    name: text(row.name),
    launched: text(row.launchedAt).slice(0, 10),
    leadsPending: int(object(row.progress).pending),
    leadsContacted: int(object(row.progress).contacted),
  });
  const rows = (value: unknown, limit: number) =>
    array(value)
      .filter((row) => text(row.name))
      .slice(0, limit)
      .map(campaign);
  const activeCampaigns = status.available
    ? {
        definition:
          "Active means the campaign is live and still has leads pending, i.e. leads yet to enter the sequence. A campaign with no pending leads is complete even if HeyReach still calls it in progress.",
        statusKnown: true,
        active: rows(status.active, 10),
        activeWithNoRepliesThisPeriod: rows(status.activeWithoutReplies, 10),
        scheduledToLaunch: rows(status.scheduled, 6),
        completedNoLeadsLeftToContact: rows(status.workedThrough, 6),
        paused: rows(status.paused, 6),
      }
    : {
        statusKnown: false,
        note: "Live campaign status was unavailable. Do not state which campaigns are active; say the status needs confirming in HeyReach.",
      };

  /**
   * The funnel, measured across the selected campaigns only.
   *
   * Every rate here carries its denominator, because "reply rate 14%" invites the model to divide by
   * whatever number is nearest and get a different answer than the page shows.
   */
  const funnel = object(client.metrics);
  const performance = funnel.available
    ? {
        scope: `Rates cover only the ${int(funnel.campaignCount)} campaign(s) selected for this report, over the period.`,
        connectionRequestsSent: int(funnel.connectionsSent),
        connectionRequestsAccepted: int(funnel.connectionsAccepted),
        averageAcceptanceRatePercent: Number((Number(funnel.acceptanceRate) || 0).toFixed(1)),
        acceptanceRateNote: "Mean of each selected campaign's own accepted ÷ sent.",
        replyRatePercent: Number((Number(funnel.replyRate) || 0).toFixed(1)),
        positiveReplyRatePercent: Number((Number(funnel.positiveReplyRate) || 0).toFixed(1)),
        rateDenominatorNote: "Reply rate and positive reply rate are replies ÷ connections accepted.",
        repliesFromLeads: int(funnel.leadsReplied),
      }
    : {
        available: false,
        note: "Campaign funnel figures were unavailable, so do not quote acceptance or reply rates.",
      };

  return {
    activeCampaigns,
    performance,
    client: text(object(client.workspace).name),
    totalReplies: int(summary.totalReplies),
    positiveReplies: int(summary.positiveReplies),
    neutralReplies: int(summary.neutralReplies),
    negativeReplies: int(summary.negativeReplies),
    positiveRatePercent: Math.round(Number(summary.positiveRate) || 0),
    averageRepliesPerDay: Number((Number(summary.avgRepliesPerDay) || 0).toFixed(1)),
    daysWithReplies: trend.length,
    trajectory,
    hotConversationCount: int(summary.hotCount),
    highFitLeadCount: int(summary.topIcpCount),
    icpDistribution: {
      excellent: int(icp.excellent),
      strong: int(icp.strong),
      moderate: int(icp.moderate),
      weak: int(icp.weak),
    },
    topCampaigns: array(client.campaigns)
      .slice(0, 5)
      .map((row) => ({ name: text(row.name), replies: int(row.replies), positiveRatePercent: int(row.positiveRate) })),
    topSenders: array(client.senders)
      .slice(0, 5)
      .map((row) => ({ name: text(row.name), replies: int(row.replies), positiveRatePercent: int(row.positiveRate) })),
    topLeads: array(client.topLeads)
      .slice(0, 5)
      .map((row) => ({
        name: text(row.name),
        role: text(row.role),
        company: text(row.company),
        icpScore: int(row.icpScore),
      })),
  };
}

/**
 * Joins the model's blocks and the account manager's own words into the email that gets sent.
 *
 * The account manager's sections are pasted in, not passed through the model. Asking a model to
 * "reproduce this verbatim" is a request, not a guarantee: told to fold the written sections into its
 * bullets it rewrote them, so "we want to buy a zoo" came back as three plausible priorities about
 * retarget campaigns. Whatever is typed into those boxes is what the client reads, character for
 * character, and the model only ever writes the blocks derived from the numbers.
 *
 * A section the account manager left blank falls back to the model where a model can reasonably fill it
 * (priorities, the close) and is dropped where it cannot (their recap, what they did — the app does not
 * know what they did).
 */
function assembleEmail(parts: Json, written: Record<string, string>) {
  const list = (value: unknown) =>
    (Array.isArray(value) ? value.map((row) => text(row)) : [])
      .filter(Boolean)
      .map((line) => (line.startsWith("-") ? line : `- ${line}`));

  const blocks: string[] = [];
  const section = (heading: string, body: string[]) => {
    const lines = body.filter(Boolean);
    if (lines.length) blocks.push(`**${heading}**\n${lines.join("\n")}`);
  };

  const subject = text(parts.subject);
  if (subject) blocks.push(`Subject: ${subject}`);

  // Skipped only when their own opening already greets the reader, which is the one case where keeping
  // both would greet them twice — and of the two, the model's is the one that sounds like software.
  const greetsAlready = /^\s*(hi|hey|hello|good morning|good afternoon|happy)\b/i.test(written.recap || "");
  const greeting = greetsAlready ? "" : text(parts.greeting);
  if (greeting) blocks.push(greeting);

  // Their words first, then the numbers under the same heading — the order every recap that works uses.
  section("Recap from this week", [written.recap || "", ...list(parts.recapBullets)]);
  section("What we did this week", [written["what-we-did"] || ""]);
  section("Active campaigns", list(parts.campaignBullets));
  section("Priorities next week", [written.priorities || list(parts.priorityBullets).join("\n")]);

  const close = written["warm-close"] || text(parts.close);
  if (close) blocks.push(close);

  // Nothing usable came back and nothing was typed. Better to hand back the model's own prose, if it
  // sent any, than an empty box.
  return blocks.join("\n\n") || text(parts.message);
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY)
    return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as Json;
  const prompt = text(body.prompt);
  if (!prompt) return NextResponse.json({ ok: false, error: "No template prompt was supplied." }, { status: 400 });

  const clients = array(body.clients);
  if (!clients.length)
    return NextResponse.json({ ok: false, error: "There is no report data to write about." }, { status: 400 });

  const periodLabel = text(body.periodLabel) || "the period";
  const digests = clients.map(digest);
  const totalReplies = digests.reduce((total, item) => total + item.totalReplies, 0);

  /**
   * What the account manager typed into the report's written sections.
   *
   * This is the half of the report the app cannot know — booked meetings, why a campaign was paused,
   * what was promised on a call. It is treated as fact and outranks the model's reading of the numbers,
   * but it must not be rewritten: the client is going to read those words as they were typed, so the
   * message has to agree with them rather than paraphrase them into something slightly different.
   */
  const written = Object.entries(object(body.written))
    .map(([section, value]) => [section, text(value)] as const)
    .filter(([, value]) => value);

  const writtenBlock = written.length
    ? `
The account manager wrote these sections. They are already in the email, character for character, and
the app puts them there — not you. They are true, and they may contain facts that appear nowhere in the
data below: booked meetings, calls, why a campaign was paused.

They are shown to you for one reason only: so that nothing you write contradicts them or says the same
thing twice. Do not reproduce them, summarise them, improve them, or write a block that covers the same
ground.

${written.map(([section, value]) => `[${section}]\n${value}`).join("\n\n")}
`
    : "";

  const userContent = `${prompt}

Follow the structure and the length the instructions above give for each block.

Period covered: ${periodLabel}
${digests.length > 1 ? `This report covers ${digests.length} clients. Write about the portfolio as a whole.` : ""}
${writtenBlock}
Report data (JSON — these are the only numbers you may use):
${JSON.stringify(digests.length === 1 ? digests[0] : digests, null, 2)}`;

  const requestedModel = text(body.model) || process.env.ANTHROPIC_MODEL || FALLBACK_MODEL;
  let model = requestedModel;

  // 1200 is comfortably above the ~350 words of JSON this can return. The narrative and message are
  // both capped by the prompt, so the ceiling exists to stop a runaway, not to shape the output.
  const requestBody = (m: string) =>
    JSON.stringify({
      model: m,
      max_tokens: 1200,
      temperature: 0,
      system: COMPOSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

  const headers = {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
  };

  try {
    const startedAt = Date.now();
    let response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: requestBody(model) });
    if (response.status === 404 && model !== FALLBACK_MODEL) {
      model = FALLBACK_MODEL;
      response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: requestBody(model) });
    }
    const payload = (await response.json().catch(() => ({}))) as Json;
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const detail = text(object(payload.error).message) || `Anthropic returned ${response.status}`;
      await writeAuditEvent(
        { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY },
        {
          actor: "anthropic",
          action: "report.compose_failed",
          entityType: "report",
          details: { source: "anthropic", status: "failed", model, durationMs, summary: detail },
        },
      );
      return NextResponse.json({ ok: false, error: detail }, { status: 502 });
    }

    const content = Array.isArray(payload.content) ? payload.content : [];
    const raw = text(object(content.find((item) => object(item).type === "text")).text);

    // The model is asked for bare JSON but sometimes fences it. Falling back to the raw text as the
    // narrative keeps a usable report on the screen rather than an error, which matters because the
    // numbers — the part that must be right — never came from the model in the first place.
    let parsed: Json = {};
    try {
      parsed = object(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    } catch {
      parsed = { narrative: raw, message: raw, headline: "" };
    }

    await writeAuditEvent(
      { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY },
      {
        actor: "anthropic",
        action: "report.composed",
        entityType: "report",
        details: {
          source: "anthropic",
          status: "success",
          model,
          durationMs,
          inputTokens: int(object(payload.usage).input_tokens),
          outputTokens: int(object(payload.usage).output_tokens),
          templateId: text(body.templateId),
          writtenSections: written.map(([section]) => section),
          clientCount: digests.length,
          totalReplies,
        },
      },
    );

    return NextResponse.json({
      ok: true,
      model,
      headline: text(parsed.headline).slice(0, 140),
      narrative: text(parsed.narrative),
      message: assembleEmail(parsed, Object.fromEntries(written)),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not reach Anthropic." },
      { status: 502 },
    );
  }
}
