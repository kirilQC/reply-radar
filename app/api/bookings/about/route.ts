// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { rows } from "../../../lib/crm-push";
import { brainContext } from "../../../lib/brain-context";

/**
 * "Write it for me" for a client's About section (the pre-call brief's description of the client). QC writes it,
 * never the team: from the client's QC Brain folder, the client's own website, and a web search for anything the
 * two leave out. Returns the text and where it came from; the page saves it straight away.
 */
export const maxDuration = 120;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const MODEL = "claude-sonnet-5-5";

/** The client's website as plain text (first page only), for the model to read. Empty when it can't be fetched. */
async function siteText(url: string): Promise<{ url: string; text: string }> {
  if (!url) return { url: "", text: "" };
  const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(full, { headers: { "user-agent": "Mozilla/5.0 (QC Command; client research)" }, signal: controller.signal, redirect: "follow" });
    clearTimeout(timer);
    if (!response.ok) return { url: full, text: "" };
    const html = await response.text();
    const body = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    return { url: full, text: body.slice(0, 15_000) };
  } catch {
    return { url: full, text: "" };
  }
}

/** QC's house rule: no em or en dashes in anything a person reads. */
const undash = (value: string) => value.replace(/\s*[—–]\s*/g, ", ").replace(/ ,/g, ",");

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const slug = text(body.slug);
  const [workspace] = await rows({ url, key }, `rr_workspaces?select=id,name,slug,brain_folder,website_url,client_brief&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!workspace) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
  const name = text(workspace.name);

  const [brain, site] = await Promise.all([
    brainContext({ slug: text(workspace.slug), name, brain_folder: text(workspace.brain_folder) }).catch(() => ({ block: "", documents: [] as string[], folder: "", reason: "" })),
    siteText(text(workspace.website_url)),
  ]);
  const clientBrief = text(workspace.client_brief);

  const prompt = [
    `Write the "About ${name}" section that QC Growth's pre-call briefs use. A salesperson reads it just before a call with a prospect who booked a meeting with ${name}, so it must say plainly:`,
    `1. What ${name} sells and how it works, in one paragraph.`,
    `2. Who buys it: industries, company types and sizes, and the roles that buy or use it, in one paragraph.`,
    `3. The problems it solves and why customers choose it over the alternatives, in one paragraph.`,
    "",
    "Rules:",
    "- Three short paragraphs, plain words, no marketing language, no headings, no bullet points.",
    "- Only facts found in the material below or in your web search. Never invent customers, numbers, funding or claims. Leave out anything you can't confirm.",
    `- Use the QC Brain notes first (they are QC's own research on ${name}), then the website, then search the web for what those leave out (what the product does, who it's for, recent news). Search ${name}'s own site and reputable sources.`,
    "- Never use em dashes or en dashes. Use commas or full stops.",
    "- Reply with only the three paragraphs.",
    "",
    clientBrief ? `QC's client brief for ${name}:\n${clientBrief.slice(0, 6000)}` : "",
    brain.block ? `QC Brain notes on ${name}:\n${brain.block}` : `There are no QC Brain notes for ${name}.`,
    site.text ? `${name}'s website (${site.url}), as text:\n${site.text}` : site.url ? `${name}'s website (${site.url}) could not be read; search for it.` : `QC has no website on file for ${name}; search for it.`,
  ].filter(Boolean).join("\n");

  const headers = { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
  const ask = (withSearch: boolean) => fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      // Sonnet 5.5 thinks by default and thinking counts against max_tokens; keep it to between tool calls.
      thinking: { type: "between_tools" },
      ...(withSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  let response = await ask(true);
  let usedSearch = true;
  // Web search off for this key or model: write from the brain and the website alone.
  if (response.status === 400) { response = await ask(false); usedSearch = false; }
  const payload = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) return NextResponse.json({ ok: false, error: `Claude could not write it (${response.status}): ${text(((payload.error ?? {}) as Row).message).slice(0, 200)}` }, { status: 502 });

  const blocks = Array.isArray(payload.content) ? (payload.content as Row[]) : [];
  const about = undash(blocks.filter((block) => block.type === "text").map((block) => text(block.text)).join("\n\n").replace(/\n{3,}/g, "\n\n").trim());
  if (!about) return NextResponse.json({ ok: false, error: "Claude returned nothing. Try again." }, { status: 502 });

  // Where it came from, for the chips under the text.
  const searched = new Set<string>();
  for (const block of blocks) {
    if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
    for (const result of block.content as Row[]) {
      try { searched.add(new URL(text(result.url)).hostname.replace(/^www\./, "")); } catch { /* not a link */ }
    }
  }
  const sources = [
    ...(brain.documents.length ? [`QC Brain · ${brain.documents.length} ${brain.documents.length === 1 ? "doc" : "docs"}`] : []),
    ...(clientBrief ? ["Client brief"] : []),
    ...(site.text ? [site.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")] : []),
    ...[...searched].slice(0, 5),
  ];
  return NextResponse.json({ ok: true, about, sources, usedSearch, stop: payload.stop_reason ?? null });
}
