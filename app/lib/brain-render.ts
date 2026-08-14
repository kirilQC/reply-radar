/**
 * Laying a brain document out again so somebody reads it.
 *
 * ── The problem this solves ─────────────────────────────────────────────────────────────────────
 * The QC Brain is right about everything and read by nobody. A client's ICP is four hundred lines of
 * bold labels and nested bullets written in a text editor by whoever was closest to the call, and it
 * renders as a grey column. The information is not missing; the reason to look at it is.
 *
 * So the document is handed to a model with one job: lay this out again. Headings that say what is
 * underneath them, a table where the prose was already a table, a row of figures where the numbers
 * are, a bar chart where the document itself is comparing things. The renderer this feeds already
 * draws all of that — `Markdown.tsx` reads `stats` and `chart` fences and lays them out in CSS — so
 * the layout is a markdown problem rather than a components problem.
 *
 * ── The two rules, and why they are not negotiable ───────────────────────────────────────────────
 * Nothing is written back to GitHub. The brain is the repository every person's Claude Code reads;
 * a model rewriting it in place, unreviewed, at the moment somebody opens a page, is the worst idea
 * available. This is a reading layer, and the file it came from is untouched — the only way text
 * reaches that repo is still a pull request somebody merges.
 *
 * And nothing may be added. Not an example, not a rounded figure, not a helpful inference, not a
 * chart that needed one more number than the document had. The instruction says so and
 * `shared/brain-render.mjs` checks the part of it that can be checked, because a document that looks
 * authoritative is believed more than the paragraph it replaced.
 *
 * ── Why the result is cached in Supabase ────────────────────────────────────────────────────────
 * Every document is laid out on first open, which is the point — nobody presses "make this readable".
 * That means one model call per document, and there are a few hundred documents, so the second person
 * to open a file must not pay for it again. The cache is keyed by the file's git blob SHA, which makes
 * invalidation exact rather than a guess: edit the document in GitHub and the SHA changes, so the next
 * reader gets a layout of the new text and never a handsome copy of the old one.
 *
 * Failure to reach the cache is not failure to render. If Supabase is unreachable the layout is still
 * produced and simply not kept, because the reader's page working matters more than the saving.
 */
import { checkRender, cleanRender } from "../../shared/brain-render.mjs";

/** Sonnet, for the same reason the MCP tab uses it: this is judgement, not classification. */
const MODEL = "claude-sonnet-4-6";
const TABLE = "rr_brain_renders";
export const RENDER_MIGRATION = "supabase/migrations/20260814_rr_brain_renders.sql";

/**
 * Documents longer than this are laid out from their first part only.
 *
 * A handful of call-note archives run to tens of thousands of words, and asking for the whole thing
 * back costs more output tokens than one turn has. Truncating is visible in the coverage warning the
 * page shows, which is the honest outcome: the reader is told the layout is partial rather than
 * shown a shortened document that looks complete.
 */
const MAX_SOURCE = 24_000;

export type BrainRender = {
  path: string;
  markdown: string;
  model: string;
  /** Figures in the layout that the source does not state, and how much of its length survived. */
  warnings: { figures: string[]; coverage: number; thin: boolean };
  renderedAt: string;
  cached: boolean;
};

type Row = Record<string, unknown>;

const store = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
};

const headers = (where: Record<string, string> = {}) => {
  const held = store();
  return held ? { apikey: held.key, Authorization: `Bearer ${held.key}`, "content-type": "application/json", ...where } : null;
};

/**
 * The kept layout for this exact version of this file, if there is one.
 *
 * A mismatched SHA is treated as a miss rather than as something to clean up. The stale row is
 * overwritten by the write that follows, and deleting it first would mean a reader whose render then
 * failed would lose a layout that, while out of date, was still better than nothing.
 */
export async function cachedRender(path: string, sha: string): Promise<BrainRender | null> {
  const held = store();
  const head = headers();
  if (!held || !head || !sha) return null;
  const query = `${TABLE}?select=path,source_sha,markdown,model,warnings,rendered_at&path=eq.${encodeURIComponent(path)}&limit=1`;
  const response = await fetch(`${held.url}/rest/v1/${query}`, { headers: head, cache: "no-store" }).catch(() => null);
  if (!response?.ok) return null;
  const rows = ((await response.json().catch(() => [])) as Row[]) ?? [];
  const row = rows[0];
  if (!row || String(row.source_sha ?? "") !== sha || !String(row.markdown ?? "")) return null;
  const warnings = (row.warnings && typeof row.warnings === "object" ? row.warnings : {}) as Row;
  return {
    path,
    markdown: String(row.markdown),
    model: String(row.model ?? ""),
    warnings: {
      figures: Array.isArray(warnings.figures) ? warnings.figures.map(String) : [],
      coverage: typeof warnings.coverage === "number" ? warnings.coverage : 1,
      thin: warnings.thin === true,
    },
    renderedAt: String(row.rendered_at ?? ""),
    cached: true,
  };
}

/** Keeps a layout. Silent on failure: this is a saving, and the reader already has their page. */
async function keepRender(path: string, sha: string, render: BrainRender): Promise<void> {
  const held = store();
  const head = headers({ Prefer: "resolution=merge-duplicates,return=minimal" });
  if (!held || !head) return;
  await fetch(`${held.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: head,
    body: JSON.stringify({
      path,
      source_sha: sha,
      markdown: render.markdown,
      model: render.model,
      warnings: render.warnings,
      rendered_at: new Date().toISOString(),
    }),
  }).catch(() => null);
}

/** Drops the kept layout for a path, so the next reader gets a fresh one. */
export async function forgetRender(path: string): Promise<void> {
  const held = store();
  const head = headers();
  if (!held || !head) return;
  await fetch(`${held.url}/rest/v1/${TABLE}?path=eq.${encodeURIComponent(path)}`, {
    method: "DELETE",
    headers: head,
  }).catch(() => null);
}

/**
 * What the model is told, and it is nearly all prohibition.
 *
 * The temptation this has to defeat is specific and strong: asked to make a document visual, a model
 * will reach for the visual the document nearly supports. It will average two rates into a third, put
 * an "estimated" column on a table, invent a fourth persona to balance a three-column layout, and
 * round 1,998 to 2,000 because it reads better. Each of those is a lie in a file that people quote in
 * client calls, and none of them look like lies.
 *
 * The positive half is short because the renderer is what makes it possible: the fences named here are
 * ones the app already draws, so "put the figures in a row" is a real instruction rather than a wish.
 */
const SYSTEM = `You lay out documents. You are given one markdown document from an internal knowledge base and you return the same document laid out so a person will actually read it.

This is a formatting job. It is not a writing job, an editing job or a summarising job.

Absolute rules:
- Every fact, name, number, place, bullet and caveat in the source must survive in your output. Losing one is a failure.
- Add nothing. No new facts, no examples, no estimates, no averages, no totals you calculated, no advice, no commentary, no "note:" additions, no filler to balance a layout.
- Never change a number. Not its value, not its rounding, not its unit. 1,998 stays 1,998.
- Never invent a figure to complete a visual. If the document does not contain the numbers a chart would need, do not draw the chart.
- Keep every campaign code (like CT50, WLW-Q3) exactly as written — other parts of the app match on them.
- Keep the document's own wording wherever it carries meaning. You may split a run-on line, promote a bold label to a heading, and turn a list of pairs into a table. You may not paraphrase a definition or reword a rule.
- No HTML. Markdown only.

What good output looks like:
- A short title, then the document's own structure as real headings, so it can be skimmed.
- Tables where the source is already a list of things with the same attributes — personas, tiers, tools, competitors.
- Blockquotes for the one or two lines that change what somebody does.
- Bold for the labels that are already labels, and nothing else in bold.
- A row of headline figures where the document states figures, using a fenced block tagged \`stats\` containing JSON: {"items":[{"label":"Reply rate","value":"24.2%","note":"ortho track"}]}. Values are copied as strings, exactly as the source writes them. Maximum six.
- A bar chart only where the source compares quantities it actually states, using a fenced block tagged \`chart\` containing JSON: {"type":"bar","title":"...","unit":"%","series":[{"label":"...","value":24.2}]}. Every value must appear in the source.
- Horizontal rules between major parts, used sparingly.

Return the laid-out markdown and nothing else. No preamble, no explanation of what you changed, and do not wrap the whole document in a code fence.`;

/**
 * Asks for a layout, checks it, and returns it with whatever the check found.
 *
 * `temperature: 0`, because there is nothing here to be creative about and two readers of the same
 * document should not get two different layouts of it.
 */
async function askForLayout(path: string, text: string): Promise<BrainRender> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured, so documents cannot be laid out.");

  const source = text.length > MAX_SOURCE ? text.slice(0, MAX_SOURCE) : text;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16_000,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: `File: ${path}\n\n---\n\n${source}` }],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) {
    const error = (payload.error && typeof payload.error === "object" ? (payload.error as Row) : {}) as Row;
    throw new Error(String(error.message ?? `The model returned ${response.status}.`));
  }
  const blocks = Array.isArray(payload.content) ? (payload.content as Row[]) : [];
  const markdown = cleanRender(blocks.filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("")) as string;
  if (!markdown) throw new Error("The model returned nothing to show.");

  const checked = checkRender(source, markdown) as { figures: string[]; coverage: number; thin: boolean };
  return {
    path,
    markdown,
    model: MODEL,
    warnings: checked,
    renderedAt: new Date().toISOString(),
    cached: false,
  };
}

/**
 * The layout for a document: the kept one if it matches, otherwise a new one, kept for next time.
 *
 * `force` skips the read but not the write, which is what the "lay this out again" affordance needs —
 * a document whose layout came out badly is re-done once and then fast for everybody again.
 */
export async function renderBrainDoc({
  path,
  text,
  sha,
  force = false,
}: {
  path: string;
  text: string;
  sha: string;
  force?: boolean;
}): Promise<BrainRender> {
  if (!force) {
    const kept = await cachedRender(path, sha);
    if (kept) return kept;
  }
  const made = await askForLayout(path, text);
  await keepRender(path, sha, made);
  return made;
}
