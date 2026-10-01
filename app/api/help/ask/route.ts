// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The help button's brain. Takes a teammate's question (plus the page they are on and the last few
 * turns), finds the Help center articles most likely to answer it, and has Claude answer from those
 * articles only, linking each one it used by its /help/<slug> address.
 *
 * Grounded on purpose: the model is told to say it does not know rather than invent a button. Anything
 * deeper (live data, "why is Willow's inbox empty") is handed to QC Bot or Feedback.
 */

import { NextResponse } from "next/server";
import { readHelp, searchHelp } from "../../../lib/help-center";
import { articlePath, HELP_KINDS, HELP_PAGES, type HelpArticle, pageLabel } from "../../../lib/help-shared";

const MODEL = process.env.HELP_WIDGET_MODEL || "claude-haiku-4-5-20251001";

type Turn = { role: "user" | "assistant"; content: string };

/** "/inbox?client=x" → "/inbox", "/cold-calling/cotool" → "/cold-calling". */
const pageRoot = (path: string) => {
  const first = `/${String(path || "/").split("?")[0].split("/").filter(Boolean)[0] ?? ""}`;
  return HELP_PAGES.some((page) => page.path === first) ? first : first === "/" ? "/" : "";
};

const noDashes = (text: string) => text.replace(/\s*[—–]\s*/g, ", ");

const asContext = (article: HelpArticle) =>
  `### ${article.title}\nURL: ${articlePath(article)}\nType: ${HELP_KINDS.find((k) => k.key === article.kind)?.label ?? article.kind}${article.page ? ` · Page: ${pageLabel(article.page)}` : ""}\n${article.body}`;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { question?: unknown; page?: unknown; history?: unknown };
  const question = String(body.question ?? "").trim().slice(0, 1200);
  if (!question) return NextResponse.json({ ok: false, error: "Ask a question first." }, { status: 400 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "The helper isn't connected to AI yet. Search the Help center instead." }, { status: 503 });
  }

  const page = pageRoot(String(body.page ?? ""));
  const history = (Array.isArray(body.history) ? body.history : [])
    .filter((turn): turn is Turn => Boolean(turn) && (turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string")
    .slice(-6)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2000) }));

  const articles = await readHelp();
  const lastUserTurn = [...history].reverse().find((turn) => turn.role === "user")?.content ?? "";
  const found = searchHelp(articles, `${question} ${lastUserTurn}`, 6);
  const onPage = page ? articles.filter((a) => a.page === page).slice(0, 4) : [];
  const picked = [...found, ...onPage].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i).slice(0, 8);

  const system = `You are the friendly help guide inside QC Command, the internal platform QC Growth's team uses to run clients' LinkedIn outreach (replies, leads, calls, meetings, projects, reports, Slack automations).

The person asking is a QC teammate${page ? ` who is currently on the ${pageLabel(page) || page} page` : ""}.

Answer ONLY from the Help center articles below. Rules:
- Be brief: under 120 words. Lead with the answer, then numbered steps if there are steps.
- Write button and field names in **bold**, exactly as the articles write them.
- Link the article you used, inline, as a markdown link with its URL, e.g. [Working the Follow-ups list](/help/working-the-follow-ups-list).
- If the articles don't cover it, say so plainly in one sentence and suggest asking @QC Bot in Slack (it can look at live data) or sending it through Configuration → Feedback. Never invent buttons, pages or steps.
- Plain, warm, direct. No em dashes. No sign-off.

Help center articles:
${picked.length ? picked.map(asContext).join("\n\n") : "(none matched this question)"}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages: [...history, { role: "user", content: question }] }),
      signal: AbortSignal.timeout(25_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload?.error?.message ?? `AI request failed (${response.status}).`));
    const answer = noDashes(
      (Array.isArray(payload?.content) ? payload.content : [])
        .filter((block: { type?: string }) => block?.type === "text")
        .map((block: { text?: string }) => block.text ?? "")
        .join("")
        .trim(),
    );
    const cited = picked.filter((a) => answer.includes(articlePath(a)));
    return NextResponse.json({
      ok: true,
      answer: answer || "I couldn't come up with an answer. Try the Help center search, or ask @QC Bot in Slack.",
      sources: (cited.length ? cited : found.slice(0, 2)).map((a) => ({ title: a.title, url: articlePath(a), kind: a.kind })),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Something went wrong.", sources: found.slice(0, 3).map((a) => ({ title: a.title, url: articlePath(a), kind: a.kind })) },
      { status: 502 },
    );
  }
}
