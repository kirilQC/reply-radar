/**
 * The one document a client's brain folder never contains: all of it, at once.
 *
 * ── What is being asked for ─────────────────────────────────────────────────────────────────────
 * A client's context is spread over a brief, an ICP, personas, a voice note, engagement rules, a CRM
 * export and however many call notes somebody committed. Every one of those is written for a person
 * who already knows the other six. So the thing that gets asked for over and over — by a new writer,
 * by a client on a kickoff call, by whoever is about to build a list — is a single document that says
 * who we are targeting and why, and that can be read start to finish without opening a repository.
 *
 * Nobody writes it, because writing it means reading eight files and it goes out of date the week
 * after. This assembles it on demand instead, from whatever the folder holds at that moment.
 *
 * ── Why the instructions are editable and stored ─────────────────────────────────────────────────
 * What belongs in an ICP document is a matter of opinion that changes as the agency's own positioning
 * changes, and it is exactly the kind of opinion the person running the agency holds and a developer
 * does not. So the prompt below is a starting point rather than the definition: it lives in
 * `rr_app_config` under one key, it is edited in Configuration → AI → Prompts, and the button that
 * generates the document reads whatever is stored there. The constant here is only what a fresh install
 * gets, and what "Reset to default" restores.
 *
 * ── Why no visuals ──────────────────────────────────────────────────────────────────────────────
 * The reading layer for brain documents draws charts and tile maps as CSS divs, which is right on a
 * screen and wrong for this: this document exists to be printed and sent, and a CSS grid crossing a
 * page break is worse than the table it replaced. Headings, tables, bullets and blockquotes are what a
 * browser's print engine handles well, so those are what the instructions ask for.
 */
import { readConfig } from "./app-config";

const MODEL = "claude-sonnet-4-6";
export const ICP_DOC_PROMPT_KEY = "icp_doc_prompt";

/**
 * How much of a client's folder is handed over.
 *
 * Generous, because the whole point is that this document is the one thing that has read everything —
 * a summary built from half the folder is the problem it was meant to solve. Where a folder does
 * exceed this, the longest files are cut first and the document says which, rather than quietly
 * describing a client from a third of the evidence.
 */
const MAX_SOURCE = 90_000;

/** Roughly three to five printed pages of prose and tables. */
const MAX_OUTPUT = 8_000;

export const DEFAULT_ICP_DOC_PROMPT = `You are writing the ideal customer profile document for one client of a B2B outbound growth agency. You will be given every file the agency holds on that client — the brief, the ICP notes, personas, tone of voice, engagement rules, call notes, CRM exports, whatever exists. Some of it will be contradictory, out of date or half-written.

Write the document somebody would want on the first day of working on this account: three to five pages that say who we target, why they buy, how we speak to them and what we do not do.

## Structure

Use these sections, in this order, with a level-2 heading each. Drop a section only if the files say nothing at all about it, and if you drop one, say so in the closing section.

1. **Who they are** — the client company in a short paragraph: what they sell, to whom, how they make money, what makes them different from the obvious alternative.
2. **Who we target** — the ideal customer profile as a table: industry or vertical, company size, geography, tech or tooling, and any hard qualifier. One row per attribute, with the criterion and, where the files give one, the reason it matters.
3. **The people we message** — one subsection per persona: their title, what they are measured on, what they already believe, and the line that gets a reply from them. Use a table when the personas are directly comparable.
4. **Why they buy** — the pains, triggers and the value the client actually delivers, in the client's own framing rather than a generic one. Name the competitor or status quo we are displacing where the files identify it.
5. **How we speak to them** — tone, vocabulary to use, vocabulary to avoid, message length, whether the first touch pitches. Quote the client's own phrasing where the files provide it.
6. **What we do not do** — exclusions, do-not-contact rules, banned claims, compliance limits, industries or accounts that are off limits. Put each hard rule in its own blockquote, because these are the ones that cost money when broken.
7. **What is running** — the campaigns, tracks or sequences the files describe, and any results they state. A table if there is more than one.
8. **Gaps** — what a person working this account still needs and the files do not answer. Be specific: "no do-not-contact list has been written" is useful, "more research needed" is not.

## Rules

- Everything in this document must come from the files. No industry knowledge, no benchmarks, no invented figures, no illustrative examples, no advice about what the client should do.
- Never change a number, a company name, a title or a campaign code. Copy them exactly.
- Where the files disagree, say so in one sentence and prefer the more recent or more specific file.
- Where the files are silent, say they are silent. An honest gap is worth more than a plausible paragraph — this document will be read as fact by people who will not check it.
- Write in plain declarative sentences. No filler, no "in today's competitive landscape", no restating the section heading as a first line.
- Formatting: level-2 headings for sections, level-3 for subsections, markdown tables, bullets and blockquotes. No fenced code blocks, no HTML, no images.
- Start with a level-1 heading naming the client and the document, then a one-paragraph summary before the first section. Nothing else before it — no preamble, no note about what you were given.`;

/** The stored instructions, or the ones above if nobody has changed them. */
export async function icpDocPrompt(): Promise<string> {
  const stored = await readConfig(ICP_DOC_PROMPT_KEY).catch(() => null);
  const text = typeof stored === "string" ? stored.trim() : "";
  return text || DEFAULT_ICP_DOC_PROMPT;
}

export type IcpSource = { path: string; text: string };

/**
 * Everything the folder holds, as one transcript, longest files trimmed first.
 *
 * Trimming the longest rather than dropping the last keeps every file represented: a call-note archive
 * losing its second half still contributes its first, whereas dropping whole files at the end of an
 * alphabetical list would silently lose voice.md because somebody committed a big CSV.
 */
export function assembleSources(sources: IcpSource[], budget = MAX_SOURCE) {
  const kept = sources.filter((source) => source.text.trim().length > 0);
  if (!kept.length) return { transcript: "", trimmed: [] as string[] };

  const share = Math.max(1_200, Math.floor(budget / kept.length));
  const trimmed: string[] = [];
  // Files under their share leave room behind, so the ones over it get that room back before cutting.
  const spare = kept.reduce((sum, source) => sum + Math.max(0, share - source.text.length), 0);
  const over = kept.filter((source) => source.text.length > share).length;
  const allowance = share + (over ? Math.floor(spare / over) : 0);

  const parts = kept.map((source) => {
    let text = source.text;
    if (text.length > allowance) {
      text = text.slice(0, allowance);
      trimmed.push(source.path);
    }
    return `## FILE: ${source.path}\n\n${text}`;
  });
  return { transcript: parts.join("\n\n---\n\n"), trimmed };
}

/**
 * Writes the document.
 *
 * `temperature: 0.2` rather than the flat 0 the layout renderer uses. That one is a transformation of a
 * document into a better-shaped copy of itself, where two different answers would both be wrong. This
 * is prose, and prose at zero reads like a form.
 */
export async function writeIcpDoc({
  label,
  sources,
  prompt,
}: {
  label: string;
  sources: IcpSource[];
  prompt: string;
}): Promise<{ markdown: string; model: string; trimmed: string[]; files: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured, so the document cannot be written.");

  const { transcript, trimmed } = assembleSources(sources);
  if (!transcript) throw new Error(`There is nothing written about ${label} in the brain to build a document from.`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_OUTPUT,
      temperature: 0.2,
      system: prompt,
      messages: [{ role: "user", content: `Client: ${label}\n\nEvery file the brain holds on them follows.\n\n---\n\n${transcript}` }],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? `The model returned ${response.status}.`));
  }
  const blocks = Array.isArray(payload.content) ? (payload.content as Record<string, unknown>[]) : [];
  const markdown = blocks
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("")
    .trim();
  if (!markdown) throw new Error("The model returned nothing to show.");

  return { markdown, model: MODEL, trimmed, files: sources.length };
}
