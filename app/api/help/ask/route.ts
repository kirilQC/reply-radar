// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The help bubble's brain: Scout, the same assistant as the Scout tab and QC Bot, with every tool, but
 * held to the bubble's job. Quick help, quick facts and fixing problems are answered here in a few lines;
 * anything that needs a table, a long list, a report or an export gets its headline plus a link that
 * opens the full answer in the Scout tab (/scout?ask=…). When it cannot solve something, it sends the
 * person to Kiril and to the bubble's Report to Kiril form.
 */

import { NextResponse } from "next/server";
import { runAgent, type Turn } from "../../../lib/assistant-run";
import { HELP_PAGES, pageLabel } from "../../../lib/help-shared";

export const maxDuration = 120;

type Row = Record<string, unknown>;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** "/inbox?client=x" → "/inbox", "/cold-calling/cotool" → "/cold-calling". */
const pageRoot = (path: string) => {
  const first = `/${String(path || "/").split("?")[0].split("/").filter(Boolean)[0] ?? ""}`;
  return HELP_PAGES.some((page) => page.path === first) ? first : "/";
};

const noDashes = (text: string) => text.replace(/\s*[—–]\s*/g, ", ");

const bubbleRules = (page: string, path: string, scoutLink: string) => `You are answering inside Scout's small help bubble in the corner of QC Command, not the Scout tab. The person is on the ${pageLabel(page) || "Dashboard"} page (${path}).

The bubble's job: quick help on how things work, fixing problems, and quick facts. So:
- Under 90 words. Lead with the answer. Numbered steps when there are steps. **Bold** button and page names exactly as the app writes them.
- Never use tables, charts, stats, cards, maps, timelines or export blocks here, and never list more than 5 items.
- How-to, "where is", "what does this mean" and "this is broken" questions: call help_center first, walk them through it briefly and link the article.
- Quick factual questions ("how many clients do we have", "how many replies this week", "which clients are missing a messaging doc"): look it up with your tools and answer with the number in a plain full sentence, e.g. "12 of your 30 clients have no messaging doc." If it's 5 names or fewer, name them. Client settings live in rr_workspaces (describe_data explains where each one is); check the real field before saying something is missing.
- If the full answer needs more room (a list over 5 items, a table, a report, an export, a comparison or real analysis): give the one-line headline (the count, the top finding), then on its own line exactly: [Open the full answer in Scout →](${scoutLink})
- Get counts from the tools, not by counting rows in your head: use query_data with countOnly and a filter (a blank text field can be null or "", so check both and add them). Finish working it out before you write anything. Never correct yourself in the answer ("wait", "let me recount"); the answer you write is final.
- More than 5 names is a list: give the count in one sentence and the Scout link, not the names.
- Do not narrate what you are doing; only your final answer is shown here.
- If you can't solve it, or they're still stuck or unhappy after your answer: tell them to reach out to Kiril, and that they can tap **Report to Kiril** at the bottom of this bubble, type out the bug or feature request and attach a screenshot. It goes straight to Kiril and he'll work on it. Do not file a support ticket yourself from the bubble.`;

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const body = (await request.json().catch(() => ({}))) as Row;
  const question = String(body.question ?? "").trim().slice(0, 2000);
  if (!question) return NextResponse.json({ ok: false, error: "Ask a question first." }, { status: 400 });
  if (!apiKey) return NextResponse.json({ ok: false, error: "Scout isn't connected to AI yet. Reach out to Kiril." }, { status: 503 });

  const path = String(body.page ?? "/").slice(0, 200);
  const page = pageRoot(path);
  const scoutLink = `/scout?ask=${encodeURIComponent(question)}`;

  const messages: Turn[] = [];
  for (const raw of (Array.isArray(body.history) ? body.history : []).slice(-8)) {
    const turn = raw as Row;
    const role = turn.role === "assistant" ? "assistant" : "user";
    const content = String(turn.content ?? "").slice(0, 3000).trim();
    if (!content) continue;
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content = `${previous.content as string}\n\n${content}`;
    else messages.push({ role, content });
  }
  const images = (Array.isArray(body.attachments) ? body.attachments : [])
    .map((a) => a as Row)
    .filter((a) => IMAGE_TYPES.has(String(a.mime)) && String(a.data ?? "").length > 0 && String(a.data).length < 7_000_000)
    .slice(0, 3)
    .map((a) => ({ type: "image", source: { type: "base64", media_type: String(a.mime), data: String(a.data) } }));
  const asked = images.length ? [...images, { type: "text", text: question }] : question;
  if (messages.at(-1)?.role === "user") messages.pop();
  messages.push({ role: "user", content: asked });
  if (messages[0]?.role !== "user") messages.shift();

  const files: string[] = [];
  try {
    const result = await runAgent({
      apiKey,
      messages,
      systemExtra: bubbleRules(page, path, scoutLink),
      deadlineMs: 55_000,
      emit: (event) => { if (event.type === "file") files.push(event.name); },
    });
    let answer = noDashes(result.reply.trim());
    if (!answer) answer = `I couldn't finish that here. [Open the full answer in Scout →](${scoutLink})\n\nIf it still doesn't work, reach out to Kiril.`;
    // A tool built a file the bubble cannot show: the full version lives in the Scout tab.
    if (files.length && !answer.includes("/scout?ask=")) answer += `\n\n[Open the full answer in Scout →](${scoutLink})`;
    return NextResponse.json({ ok: true, answer, scoutUrl: scoutLink });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `${error instanceof Error ? error.message : "Something went wrong."} If it keeps happening, reach out to Kiril.`, scoutUrl: scoutLink },
      { status: 502 },
    );
  }
}
