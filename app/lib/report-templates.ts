/**
 * Report templates: the sections a report contains, and the prompt Claude follows to write it.
 *
 * A template is deliberately thin — a name, an explicit page composition, and a prompt. Everything
 * expensive (the numbers) already comes from `/api/reports/generate`; the template only decides what
 * to show and how to narrate it. That is what makes adding a template a matter of writing a prompt in
 * the UI rather than shipping code.
 *
 * Section ids are also the contract with `shared/report-pagination.mjs`: every id here needs a weight
 * there, or a new section would be costed at the fallback and a four-page report could claim three.
 *
 * Templates declare `pages` as an array of arrays rather than a flat section list. This is the whole
 * mechanism behind the three-page guarantee: a template cannot exceed three pages because the page
 * boundaries are part of its definition, not an emergent property of how tall the content happens to
 * render. "Build your own" has no such structure, so it is measured instead — see `PAGE_LIMIT`.
 */

export type SectionId =
  | "cover"
  | "recap"
  | "executive-summary"
  | "metrics"
  | "kpis"
  | "sentiment"
  | "trend"
  | "active-campaigns"
  | "campaigns"
  | "senders"
  | "top-leads"
  | "icp-distribution"
  | "hot-conversations"
  | "reply-timing"
  | "sample-replies"
  | "what-we-did"
  | "priorities"
  | "warm-close"
  | "methodology";

/**
 * Sections whose content the account manager types, not sections the app computes.
 *
 * Booked meetings, why a campaign was paused, what happens next — none of that is in HeyReach or in our
 * tables, and no amount of prompt engineering will conjure it. So the report asks. A template gets an
 * input box for each of these that appears in its layout, which means adding one here and giving it a
 * weight is all it takes for the box to appear.
 */
export const WRITTEN_SECTIONS = ["recap", "what-we-did", "priorities", "warm-close"] as const;

export type WrittenSectionId = (typeof WRITTEN_SECTIONS)[number];

export const isWrittenSection = (id: SectionId): id is WrittenSectionId =>
  (WRITTEN_SECTIONS as readonly string[]).includes(id);

/** The label and placeholder each written box carries in the config screen. */
export const WRITTEN_SECTION_PROMPTS: Record<WrittenSectionId, { label: string; placeholder: string }> = {
  recap: {
    label: "Recap",
    placeholder:
      "The opening paragraph, in your words. Anything the numbers cannot say — meetings booked, who you spoke to, how the week actually went.",
  },
  "what-we-did": {
    label: "What we did this week",
    placeholder: "Campaigns launched or paused, lists built, copy tested, accounts added. One line each.",
  },
  priorities: {
    label: "Priorities for next week",
    placeholder: "What happens next, and anything you need from the client. One line each.",
  },
  "warm-close": {
    label: "Warm close",
    placeholder: "How you want to sign off. A sentence or two.",
  },
};

export type SectionDef = { id: SectionId; label: string; blurb: string; alwaysOn?: boolean };

export const SECTIONS: SectionDef[] = [
  { id: "cover", label: "Cover page", blurb: "Client, period, generated date, brand mark", alwaysOn: true },
  { id: "recap", label: "Recap", blurb: "Your own opening paragraph, typed before generating" },
  { id: "executive-summary", label: "Executive summary", blurb: "Auto-written narrative from the numbers" },
  {
    id: "metrics",
    label: "Performance metrics",
    blurb: "Replies, positives, acceptance and reply rates — selected campaigns only",
  },
  { id: "kpis", label: "Headline KPIs", blurb: "Replies, positive rate, hot leads, avg per day" },
  { id: "sentiment", label: "Sentiment breakdown", blurb: "Positive / neutral / negative split with %" },
  { id: "trend", label: "Reply trend", blurb: "Daily bar chart over the period" },
  {
    id: "active-campaigns",
    label: "Active campaigns",
    blurb: "Live in HeyReach with leads still pending, plus launch date",
  },
  { id: "campaigns", label: "Campaign performance", blurb: "Replies + positive rate per campaign" },
  { id: "senders", label: "Sender leaderboard", blurb: "Top LinkedIn accounts by reply volume" },
  { id: "top-leads", label: "Top leads", blurb: "Highest ICP scores with role, company, reason" },
  { id: "icp-distribution", label: "ICP distribution", blurb: "How your replied leads cluster" },
  { id: "hot-conversations", label: "Hot conversations", blurb: "Follow-up urgency ≥ 60 with snippets" },
  { id: "reply-timing", label: "Reply timing", blurb: "Hour-of-day heatmap in client's timezone" },
  { id: "sample-replies", label: "Sample positive replies", blurb: "Six verbatim positive replies for evidence" },
  { id: "what-we-did", label: "What we did this week", blurb: "Your own list of the work done" },
  { id: "priorities", label: "Priorities for next week", blurb: "Your own list of what happens next" },
  { id: "warm-close", label: "Warm close", blurb: "Your own sign-off" },
  { id: "methodology", label: "Methodology & notes", blurb: "How the numbers were computed", alwaysOn: true },
];

export const SECTION_LABELS: Record<SectionId, string> = SECTIONS.reduce(
  (labels, section) => ({ ...labels, [section.id]: section.label }),
  {} as Record<SectionId, string>,
);

/**
 * A client report must never run past three pages.
 *
 * This is a product rule, not a rendering detail: a ten-page PDF does not get read. Templates satisfy
 * it by construction. "Build your own" cannot, so it measures the rendered document and refuses to
 * export past the limit.
 */
export const PAGE_LIMIT = 3;

/**
 * The layout a template gets when whoever created it did not design one.
 *
 * Writing a template is meant to be a matter of typing a prompt, so the layout cannot be a required
 * decision — but a template still has to state its pages, because that declaration is what guarantees
 * it stays inside the limit.
 *
 * The shape is the client recap the agency actually sends: the account manager's own opening, then the
 * numbers and what is running, then what was done, what is next, and a sign-off. Half of that is typed
 * and half is pulled, which is the point — the report is the two halves joined, and neither half can
 * write the other.
 */
export const DEFAULT_TEMPLATE_PAGES: SectionId[][] = [
  ["cover", "recap", "metrics"],
  ["active-campaigns", "what-we-did", "priorities"],
  ["warm-close", "methodology"],
];

export type ReportPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "all-time" | "custom";

export type ReportTemplate = {
  id: string;
  name: string;
  summary: string;
  /**
   * The period the template is written for, preselected when it is opened and still changeable.
   * A template whose prompt says "the entire engagement" must not quietly produce a monthly report.
   */
  defaultPeriod: ReportPeriod;
  /** One inner array per page. Length is the page count, and it is capped at PAGE_LIMIT. */
  pages: SectionId[][];
  prompt: string;
  builtIn?: boolean;
  createdAt?: string;
};

const PERIODS = new Set<ReportPeriod>(["daily", "weekly", "monthly", "quarterly", "all-time", "custom"]);

/**
 * The prompt shared by every template.
 *
 * Kept separate from each template's own prompt so that the rules which must never be broken — no
 * invented numbers, hard length caps — cannot be edited away by someone writing a new template in the
 * UI. Template prompts describe emphasis and tone; this describes the contract.
 */
export const COMPOSE_SYSTEM_PROMPT = `You write client-facing reporting copy for QC Growth, a B2B LinkedIn outbound agency.

Rules that override any other instruction:
- Use ONLY the numbers in the supplied data. Never invent, estimate or extrapolate a figure.
- If the data is empty or a metric is zero, say so plainly. Do not dress it up.
- No greetings, no sign-offs, no "I hope this finds you well", no emoji.
- Never promise future results.
- Write in plain British-neutral business English. Short sentences. No marketing adjectives
  ("incredible", "amazing", "game-changing") and no filler ("it's worth noting that").
- Refer to the client by name, and to replies as replies — not "leads" unless describing a lead.

Return ONLY a JSON object, no prose around it, in exactly this shape:
{
  "headline": "one line, max 70 characters, the single most important fact",
  "narrative": "the executive summary for the PDF, 90-150 words, 2 short paragraphs",
  "message": "the email to send with the report attached, following the length rules given below"
}`;

export const BUILT_IN_TEMPLATES: ReportTemplate[] = [
  {
    id: "all-time-exec",
    name: "All-time executive summary",
    summary: "The whole relationship in three pages — for QBRs, renewals and exec updates.",
    defaultPeriod: "all-time",
    builtIn: true,
    // Page 1 sets the story, page 2 proves it with performance, page 3 names the people worth
    // acting on. Methodology rides along on the last page rather than earning one of its own.
    pages: [
      ["cover", "executive-summary", "kpis"],
      ["trend", "campaigns", "senders"],
      ["top-leads", "methodology"],
    ],
    prompt: `This is an all-time executive summary covering the entire engagement to date. The reader is
a senior stakeholder — often the person who approves the budget — who has not been following week to
week.

Emphasis, in order:
1. Total replies generated over the whole relationship, and the positive share of them.
2. The trajectory: is reply volume holding, growing or falling? Use the daily trend to say which.
3. Which campaign and which sender did the most work.
4. How many genuinely high-fit leads (ICP 75+) the engagement has surfaced.

The message should be an email of 120-180 words that an account manager can send with the PDF
attached. Open with the single most important number. One short paragraph of context. Close by naming
what the client should look at first in the PDF. No subject line.`,
  },
];

/** Reject a stored template that would break the page guarantee or arrive without its essentials. */
export function normaliseTemplate(input: unknown): ReportTemplate | null {
  const row = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const prompt = typeof row.prompt === "string" ? row.prompt.trim() : "";
  if (!id || !name || !prompt) return null;

  const validIds = new Set(SECTIONS.map((section) => section.id));
  const pages = Array.isArray(row.pages)
    ? row.pages
        .map((page) =>
          Array.isArray(page) ? page.filter((section): section is SectionId => validIds.has(section as SectionId)) : [],
        )
        .filter((page) => page.length)
        .slice(0, PAGE_LIMIT)
    : [];
  if (!pages.length) return null;

  return {
    id,
    name: name.slice(0, 80),
    summary: typeof row.summary === "string" ? row.summary.trim().slice(0, 200) : "",
    defaultPeriod: PERIODS.has(row.defaultPeriod as ReportPeriod) ? (row.defaultPeriod as ReportPeriod) : "monthly",
    pages,
    prompt,
    builtIn: false,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}
