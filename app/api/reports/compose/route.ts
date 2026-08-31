// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

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
import { resolveModel, temperatureField } from "../../../../shared/anthropic-model.mjs";
import { writeAuditEvent } from "../../../lib/audit-log";
import {
  COMPOSE_SYSTEM_PROMPT,
  DEFAULT_CAMPAIGN_METRICS,
  type CampaignMetricId,
} from "../../../lib/report-templates";

type Json = Record<string, unknown>;

const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
/**
 * How every email ends, without exception.
 *
 * It is the agency's signature, not a piece of copy: the close above it changes weekly and this does not,
 * so it is appended rather than written. Kept out of the model's remit and out of the warm-close box for
 * the same reason — the two places it could be typed are the two places it could go missing.
 */
const SIGN_OFF = "- QC Growth";
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
 * The Active campaigns lines, built from the report rather than written by the model.
 *
 * Every figure on these lines is exact and the account manager has chosen which of them to print, so
 * there is nothing for a model to add and one obvious thing for it to get wrong. It is the same argument
 * as the quoted replies: where the data is the message, the data is pasted in.
 *
 * Three sources have to be joined per campaign. HeyReach's campaign list knows what is live, when it
 * launched, what is pending and who is sending; its stats endpoint knows requests sent and accepted; our
 * own tables know the replies. They are joined on campaign id where both sides have one and on name
 * otherwise, because reply attribution carries a name and not an id.
 *
 * A metric with nothing behind it is left off the line rather than printed as zero — except the counts
 * that genuinely can be zero, where zero is the news. Days left is the exception's exception: no senders
 * means we cannot say, and "0 days left" would read as finished.
 */
function campaignLines(client: Json, metrics: CampaignMetricId[]): string[] {
  const status = object(client.campaignStatus);
  if (!status.available) return [];

  const wanted = new Set(metrics);
  const zone = text(object(client.workspace).timezone) || "America/New_York";
  const day = (value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: zone }).format(parsed);
  };
  const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

  const key = (value: unknown) => text(value).trim().toLowerCase();
  const replies = new Map(array(client.campaigns).map((row) => [key(row.name), row]));
  const funnel = array(object(client.metrics).campaigns);
  const funnelById = new Map(funnel.filter((row) => text(row.campaignId)).map((row) => [text(row.campaignId), row]));
  const funnelByName = new Map(funnel.map((row) => [key(row.name), row]));

  /**
   * Every campaign the report was generated for, in the order the document's table lists them.
   *
   * All four buckets, not just the live ones. The campaigns here have already been narrowed to the ones
   * ticked on the config screen, and a campaign somebody ticked belongs in their report even when it has
   * no pending leads left — being told a list is finished is the point of asking. Reading only `active`
   * meant our own definition of the word silently overrode an explicit choice.
   */
  return [
    ...array(status.active),
    ...array(status.scheduled),
    ...array(status.workedThrough),
    ...array(status.paused),
  ]
    .filter((row) => text(row.name))
    .slice(0, 12)
    .map((row) => {
      const progress = object(row.progress);
      const reply = object(replies.get(key(row.name)));
      const stats = object(funnelById.get(text(row.id)) ?? funnelByName.get(key(row.name)));
      const daysLeft = row.daysLeftInSending;
      const facts: string[] = [];

      if (wanted.has("launched") && day(text(row.launchedAt))) facts.push(`launched ${day(text(row.launchedAt))}`);
      if (wanted.has("connections-sent")) facts.push(`${int(stats.connectionsSent).toLocaleString()} sent`);
      if (wanted.has("connections-accepted")) facts.push(`${int(stats.connectionsAccepted).toLocaleString()} accepted`);
      if (wanted.has("replies")) facts.push(plural(int(reply.replies), "reply", "replies"));
      if (wanted.has("positive-replies")) facts.push(`${int(reply.positive).toLocaleString()} positive`);
      // Names, not a headcount. The client knows who Eyal and Roi are; "3 senders" is a fact they can do
      // nothing with. The count is the fallback for a workspace whose accounts we could not name.
      if (wanted.has("senders")) {
        const names = Array.isArray(row.senderNames) ? row.senderNames.map(text).filter(Boolean) : [];
        if (names.length) facts.push(names.join(", "));
        else if (int(row.senders) > 0) facts.push(plural(int(row.senders), "sender", "senders"));
      }
      if (wanted.has("pending")) facts.push(`${int(progress.pending).toLocaleString()} pending`);
      if (wanted.has("days-left") && typeof daysLeft === "number")
        facts.push(`${plural(daysLeft, "day", "days")} of sending left`);

      // Only the states that are not "running with leads to go", because that is what the section's own
      // heading already says. Left unmarked, a finished campaign reads as one still working.
      const note = STATE_NOTES[text(row.state)] ?? "";
      return `${text(row.name)}${note}${facts.length ? ` — ${facts.join(" · ")}` : ""}`;
    });
}

/**
 * How a campaign that is not actively sending is flagged on its own line.
 *
 * `active` is deliberately absent: the section is about what is running, so marking the running ones adds
 * a word to every line and distinguishes nothing.
 */
const STATE_NOTES: Record<string, string> = {
  scheduled: " (scheduled)",
  "worked-through": " (list finished)",
  paused: " (paused)",
};

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
function assembleEmail(parts: Json, written: Record<string, string>, bestReplies: Json[], campaigns: string[]) {
  const list = (value: unknown) =>
    (Array.isArray(value) ? value.map((row) => text(row)) : [])
      .filter(Boolean)
      .map((line) => (line.startsWith("-") ? line : `- ${line}`))
      .join("\n");

  const blocks: string[] = [];
  /**
   * Chunks within a section are separated by a blank line, not a newline.
   *
   * That blank line is the whole difference between a recap that reads as somebody's paragraph followed
   * by the week's numbers and one where their last sentence looks like the first bullet's preamble.
   */
  const section = (heading: string, ...chunks: string[]) => {
    const body = chunks.filter(Boolean).join("\n\n");
    if (body) blocks.push(`**${heading}**\n${body}`);
  };

  const subject = text(parts.subject);
  if (subject) blocks.push(`Subject: ${subject}`);

  // The intro box wins over the model's greeting, and it is seeded from that greeting the first time a
  // report is written — so after the first pass this is always the account manager's own line.
  const intro = written.intro || text(parts.greeting);
  if (intro) blocks.push(intro);

  // Their words first, then the numbers under the same heading — the order every recap that works uses.
  section("Recap from this week", written.recap || "", list(parts.recapBullets));
  section("What we did this week", written["what-we-did"] || "");
  // The assembled lines win; the model's bullets are only ever the "status unavailable" note.
  section("Active campaigns", campaigns.length ? list(campaigns) : list(parts.campaignBullets));
  section("Booked meetings", written["booked-meetings"] || "");

  /**
   * Verbatim, and assembled here rather than asked for.
   *
   * The point of quoting a reply to a client is that it is what the person actually wrote; a model given
   * the text to "include" would tidy it, and a tidied quote is a fabricated one. Name, title, company and
   * the message — nothing else, because everything else is our plumbing.
   */
  const quotes = bestReplies
    .map((row) => {
      const who = [text(row.role), text(row.company)].filter(Boolean).join(", ");
      const body = text(row.body).replace(/\s+/g, " ");
      if (!body) return "";
      return `${text(row.leadName) || "A lead"}${who ? ` — ${who}` : ""}\n"${body}"`;
    })
    .filter(Boolean);
  section("Best replies from this week", ...quotes);

  section("Priorities next week", written.priorities || list(parts.priorityBullets));

  const close = written["warm-close"] || text(parts.close);
  if (close) blocks.push(close);

  // Nothing usable came back and nothing was typed. Better to hand back the model's own prose, if it
  // sent any, than an empty box.
  const email = blocks.join("\n\n") || text(parts.message);
  if (!email) return "";

  /**
   * The signature, unless it is somehow already there.
   *
   * Checked rather than assumed because the warm-close box is free text and somebody will eventually
   * type the sign-off into it — and an email signed twice is a worse failure than one signed by the app
   * when the account manager meant to do it themselves.
   */
  return /qc\s*growth\s*$/i.test(email) ? email : `${email}\n\n${SIGN_OFF}`;
}

// Composing a report is a multi-step AI job; give it the full Pro budget rather than the 15s default.
export const maxDuration = 300;

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

  /**
   * The replies to quote, taken from the report rather than from the model.
   *
   * Off when the section has been unticked on the config screen, which is why this is a flag rather than
   * something inferred from whether any replies came back: no quotes and quotes-not-wanted read the same
   * in the data and mean different things to whoever is about to send this.
   */
  const bestReplies =
    body.includeBestReplies === false ? [] : clients.flatMap((client) => array(client.bestReplies)).slice(0, 5);

  /**
   * The campaign lines, and what each of them is allowed to say.
   *
   * An absent choice falls back to the default rather than to nothing, so a caller that predates the
   * toggles still gets the replies figure the section always carried. An empty array is a real choice —
   * somebody wanting the campaign names on their own — and produces bare names.
   */
  const chosenMetrics = (
    Array.isArray(body.campaignMetrics) ? body.campaignMetrics.map(text).filter(Boolean) : DEFAULT_CAMPAIGN_METRICS
  ) as CampaignMetricId[];
  const campaigns = clients.flatMap((client) => campaignLines(client, chosenMetrics));
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

  const requestedModel = resolveModel(text(body.model) || process.env.ANTHROPIC_MODEL || FALLBACK_MODEL);
  let model = requestedModel;

  // 1200 is comfortably above the ~350 words of JSON this can return. The narrative and message are
  // both capped by the prompt, so the ceiling exists to stop a runaway, not to shape the output.
  const requestBody = (m: string) =>
    JSON.stringify({
      model: m,
      max_tokens: 1200,
      ...temperatureField(m, 0),
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
      // Returned separately from the email so the page can seed the intro and warm-close boxes with them.
      // Those boxes are authoritative from then on, and the only way either can start with something in it
      // is if the line the model wrote comes back on its own rather than buried in the assembled message.
      greeting: text(parsed.greeting),
      close: text(parsed.close),
      message: assembleEmail(parsed, Object.fromEntries(written), bestReplies, campaigns),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not reach Anthropic." },
      { status: 502 },
    );
  }
}
