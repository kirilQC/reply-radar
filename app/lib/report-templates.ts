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
  | "intro"
  | "recap"
  | "executive-summary"
  | "metrics"
  | "kpis"
  | "sentiment"
  | "trend"
  | "active-campaigns"
  | "campaigns"
  | "booked-meetings"
  | "best-replies"
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
export const WRITTEN_SECTIONS = [
  "intro",
  "recap",
  "booked-meetings",
  "what-we-did",
  "priorities",
  "warm-close",
] as const;

export type WrittenSectionId = (typeof WRITTEN_SECTIONS)[number];

export const isWrittenSection = (id: SectionId): id is WrittenSectionId =>
  (WRITTEN_SECTIONS as readonly string[]).includes(id);

/** The label and placeholder each written box carries in the config screen. */
export const WRITTEN_SECTION_PROMPTS: Record<WrittenSectionId, { label: string; placeholder: string }> = {
  /**
   * The opening line, and the one written box that does not start empty.
   *
   * A greeting is the part of a recap that has to sound like a person and the part nobody wants to draft
   * from nothing, so the first compose writes one and puts it straight into this box. From then on the
   * box wins: it is a written section like any other, printed exactly as it stands.
   */
  intro: {
    label: "Intro",
    placeholder: "The opening line. Written for you when you generate, then yours to change.",
  },
  recap: {
    label: "Recap",
    placeholder:
      "The opening paragraph, in your words. Anything the numbers cannot say — meetings booked, who you spoke to, how the week actually went.",
  },
  "what-we-did": {
    label: "What we did this week",
    placeholder: "Campaigns launched or paused, lists built, copy tested, accounts added. One line each.",
  },
  "booked-meetings": {
    label: "Booked meetings",
    placeholder: "Who is on the calendar, when, and with whom. One line each.",
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
  { id: "intro", label: "Intro", blurb: "The opening line — written for you, then yours to edit" },
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
  { id: "booked-meetings", label: "Booked meetings", blurb: "Your own list of what is on the calendar" },
  {
    id: "best-replies",
    label: "Best replies from this week",
    blurb: "The five strongest replies, pulled for you — name, title, company, what they said",
  },
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

/**
 * What a campaign line in the email is allowed to say about itself.
 *
 * The Active campaigns section used to be one bullet per campaign with the replies against it, which is
 * right for a quiet week and thin for a week where the news is that a list is nearly exhausted. So the
 * facts are a per-run choice: the campaigns are picked on the config screen, and so is what gets said
 * about each of them.
 *
 * Ordered as a line reads rather than by importance — dates and counts of work done, then what is left.
 * Lives here because the config screen offers the choices and the compose route obeys them, and a label
 * that disagreed between the two would be a tick that appears to do nothing.
 */
export type CampaignMetricId =
  | "launched"
  | "connections-sent"
  | "connections-accepted"
  | "replies"
  | "positive-replies"
  | "senders"
  | "pending"
  | "days-left";

export const CAMPAIGN_METRICS: Array<{ id: CampaignMetricId; label: string }> = [
  { id: "launched", label: "Date launched" },
  { id: "connections-sent", label: "Connections sent" },
  { id: "connections-accepted", label: "Connections accepted" },
  { id: "replies", label: "Replies received" },
  { id: "positive-replies", label: "Positive replies" },
  { id: "senders", label: "Senders on this campaign" },
  { id: "pending", label: "Pending leads" },
  { id: "days-left", label: "Days left in sending" },
];

/**
 * What a campaign line says when nobody has chosen.
 *
 * Replies only, because that is what the section said before it could say anything else — an existing
 * report must not change shape because the choice arrived.
 */
export const DEFAULT_CAMPAIGN_METRICS: CampaignMetricId[] = ["replies"];

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
 *
 * Every page here weighs exactly what `PAGE_CAPACITY` allows, which is not a coincidence: this layout is
 * the ground truth the weight model is calibrated against, so a page that overflowed here would mean the
 * meter is wrong rather than that the page is. Adding a section means taking one off that page.
 */
export const DEFAULT_TEMPLATE_PAGES: SectionId[][] = [
  ["cover", "intro", "recap", "metrics"],
  ["active-campaigns", "booked-meetings", "best-replies"],
  ["what-we-did", "priorities", "warm-close", "methodology"],
];

export type ReportPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "all-time" | "custom";

/**
 * What a template actually produces.
 *
 * This used to be assumed: every template rendered a multi-page document and the email was a covering
 * note for it. That is wrong for the report QC sends most often — the Friday recap *is* an email, and
 * nobody attaches three pages of charts to it. So a template says which one it is for, and the config
 * screen leads with that.
 *
 * "email" does not mean the document is unavailable. The sections are still laid out and still hold the
 * numbers, so a PDF can be produced on demand from the same report; it is just not what you get by
 * default. The reverse is not offered, because a document template's email is only ever a covering note.
 */
export type ReportOutput = "email" | "pdf";

export const OUTPUT_LABELS: Record<ReportOutput, string> = {
  email: "Email",
  pdf: "PDF document",
};

export type ReportTemplate = {
  id: string;
  name: string;
  summary: string;
  /**
   * The period the template is written for, preselected when it is opened and still changeable.
   * A template whose prompt says "the entire engagement" must not quietly produce a monthly report.
   */
  defaultPeriod: ReportPeriod;
  /** Email or document. Governs what the report screen shows once it has generated. */
  output: ReportOutput;
  /** One inner array per page. Length is the page count, and it is capped at PAGE_LIMIT. */
  pages: SectionId[][];
  prompt: string;
  builtIn?: boolean;
  createdAt?: string;
};

const PERIODS = new Set<ReportPeriod>(["daily", "weekly", "monthly", "quarterly", "all-time", "custom"]);
const OUTPUTS = new Set<ReportOutput>(["email", "pdf"]);

/**
 * The prompt shared by every template.
 *
 * Kept separate from each template's own prompt so that the rules which must never be broken — no
 * invented numbers, hard length caps — cannot be edited away by someone writing a new template in the
 * UI. Template prompts describe emphasis and tone; this describes the contract.
 *
 * The narrative and the message are held to different rules on purpose. This used to ban greetings,
 * sign-offs and emoji outright, and because these rules override the template, it also overrode the
 * warm open and close the weekly recap asks for — so the email arrived reading like a dashboard dump,
 * which is exactly what a client recap must not be. A document has no greeting; a mail from one person
 * to another does.
 */
export const COMPOSE_SYSTEM_PROMPT = `You write client-facing reporting copy for QC Growth, a B2B LinkedIn outbound agency.

Rules that override any other instruction:
- Use ONLY the numbers in the supplied data. Never invent, estimate or extrapolate a figure.
- If the data is empty or a metric is zero, say so plainly. Do not dress it up.
- Never promise future results.
- Short sentences. No marketing adjectives ("incredible", "amazing", "game-changing") and no filler
  ("it's worth noting that", "we're excited to share", "as you can see").
- Refer to the client by name, and to replies as replies — not "leads" unless describing a lead.

"narrative" is a page in a document. It carries no greeting and no sign-off.

YOU DO NOT WRITE THE EMAIL. You write the blocks of it that come from the data, and the app assembles
the email around them. The account manager's own sections — their recap, what they did, their
priorities, their sign-off — are printed word for word exactly as typed, and you never see your output
next to theirs. So:
- Do not repeat, summarise, tidy, expand on or rephrase anything they wrote. It is already in the email.
- Do not contradict it either. If they say a campaign was paused, do not call it live.
- Do not write section headings or greetings into a block. Each block is only its own content.

Write plain text. Markdown only for emphasis inside a bullet. No tables, no headings, no links beyond
any supplied to you. Emoji only if the account manager used one in their own words.

Return ONLY a JSON object, no prose around it, in exactly this shape. Return an empty string or an empty
array for any block the data cannot support — never a placeholder:
{
  "headline": "one line, max 70 characters, the single most important fact",
  "narrative": "the executive summary for the PDF, 90-150 words, 2 short paragraphs",
  "subject": "the email subject line, no 'Subject:' prefix",
  "greeting": "the opening line, warm and human. Omit entirely if the account manager wrote their own intro",
  "recapBullets": ["one fact each, with its number, as a fragment. No leading dash"],
  "campaignBullets": ["[] unless live campaign status was unavailable — see below"],
  "priorityBullets": ["only if the account manager left their priorities blank. Otherwise []"],
  "close": "one line of warm close. No name and no sign-off — the app signs every email itself"
}

The campaign lines are written by the app, not by you. It has the exact figures for each campaign and the
account manager has chosen which of them to print, so a bullet you write about a campaign would either
duplicate that line or contradict it. Return "campaignBullets": [] whenever live campaign status was
available. The one exception is when it was not: then, and only then, return a single bullet reading
"Campaign status: [confirm in HeyReach]".`;

export const BUILT_IN_TEMPLATES: ReportTemplate[] = [
  {
    id: "weekly-recap",
    name: "Weekly client recap",
    summary: "The Friday EOW email — recap, active campaigns, priorities. Modelled on the recaps that land.",
    defaultPeriod: "weekly",
    // This one is a mail, not a deck. The sections still exist behind it for anyone who wants the PDF.
    output: "email",
    builtIn: true,
    pages: DEFAULT_TEMPLATE_PAGES,
    /**
     * Written against the recaps that actually worked, which are much shorter and much more human than
     * anything a model produces unprompted. Two things were making the output wrong: it wrote prose
     * where every good example is bullets, and it wrote to length rather than to relevance. Hence the
     * explicit shape and the hard word cap — the discipline is what makes it readable on a phone.
     */
    prompt: `This is the end-of-week recap QC sends every Friday. It is a curation, not a creation: the
numbers already exist and the job is to pick the three or four that matter and point at what happens
next.

The reader is the client contact who has not opened the dashboard all week and will read this on a phone
in under two minutes. It doubles as the agenda for a short Monday call, so it answers exactly two
questions: what happened, and what's next.

"subject": {Client} <> QC {M/D} EOW recap

"greeting": one line — warm, human, specific to the week: the season, a holiday, an event they were at.

"recapBullets": three to five, and this is the heart of it.
- One fact each, with its number, written as a fragment rather than a sentence.
- Order by signal: replies and the positive share of them first, then connection requests sent and
  accepted with the acceptance rate, then the campaign that did the most work, named.
- Name people. "Rory's Social Signals campaign drove 11 of them" beats "one campaign performed well".
- Attribute a win to something repeatable — the second follow-up, an event list, a rewritten opener —
  rather than to luck.
- A number that moved the wrong way gets one bullet and one clause of cause, then you move on. No
  apology. If a rate dipped because volume tripled, say both in the same bullet.

"campaignBullets": []. The app prints the campaign lines itself, with whichever figures the account
manager ticked for this report. The only time you fill this is when live campaign status was unavailable,
and then it is the single bullet "Campaign status: [confirm in HeyReach]" — never infer that a campaign is
live from reply activity, because a campaign with no replies looks identical to one switched off.
- What still belongs to you is the cause: if a campaign finished or was paused and that explains a dip,
  say so in a recap bullet, where the number it explains already is.

"priorityBullets": two to four — what launches, what is waiting on the client's review, what is blocked
on them, with an owner where the data gives you one. Return [] if the account manager wrote their own
priorities; theirs are used instead of yours, unedited.

"close": one line of warm close — a next step or a note about the Monday call. Not a sign-off: the app
signs every email as QC Growth, so a name here would be signed twice.

RULES:
- Your blocks come to about 100-150 words together. Five sharp bullets beat fifteen complete ones. If a
  number would not change what the client does next, cut it.
- Never leave a placeholder for a number that is simply not in the data. Leave the point out.
- Warmth is not padding. Genuine enthusiasm about a real win belongs here; invented enthusiasm does not.`,
  },
  {
    id: "all-time-exec",
    name: "All-time executive summary",
    summary: "The whole relationship in three pages — for QBRs, renewals and exec updates.",
    defaultPeriod: "all-time",
    output: "pdf",
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

The email is a covering note for the attached PDF, not the report itself. Put the whole of it in
"recapBullets" — four or five, opening with the single most important number and ending with what the
client should look at first in the PDF. Leave "campaignBullets" and "priorityBullets" empty.`,
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
    // Templates saved before this field existed rendered a document, so that is what they keep doing.
    output: OUTPUTS.has(row.output as ReportOutput) ? (row.output as ReportOutput) : "pdf",
    pages,
    prompt,
    builtIn: false,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
  };
}
