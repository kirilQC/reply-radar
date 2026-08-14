// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

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
 * Which generation of the instructions below produced a layout.
 *
 * The SHA answers "is this a layout of the current text", which is the only question that mattered
 * while the prompt was fixed. It is not the only question: the first version of the prompt returned
 * the source document with tidier headings, and every one of those layouts still matched its SHA
 * perfectly — so a better prompt would have shipped to nobody, because every document already had a
 * cached answer and nothing would ever ask again.
 *
 * Bumping this number is how a change to the instructions reaches documents that were already laid
 * out. It rides in the `warnings` json, so it costs no column and no migration, and a row written by
 * an older version reads as a miss and is replaced the next time anything walks the repository.
 */
const RENDER_VERSION = 3;

/**
 * Documents longer than this are laid out from their first part only.
 *
 * A handful of call-note archives run to tens of thousands of words, and asking for the whole thing
 * back costs more output tokens than one turn has. Truncating is visible in the coverage warning the
 * page shows, which is the honest outcome: the reader is told the layout is partial rather than
 * shown a shortened document that looks complete.
 */
const MAX_SOURCE = 24_000;

/**
 * How long one layout may take before it is abandoned.
 *
 * This used to be three minutes, on the theory that the route had five. The route has sixty seconds —
 * the plan clamps it — so a render allowed to run for a hundred and eighty was never abandoned by this
 * timeout at all: the invocation was killed first, which loses the response as well as the work, so the
 * caller learns nothing and the reader watches a spinner. Cut to fit inside the function, so a document
 * that will not lay out in time comes back as an error somebody can see and retry.
 */
const RENDER_TIMEOUT_MS = 40_000;

export type BrainRender = {
  path: string;
  markdown: string;
  model: string;
  /** Figures in the layout that the source does not state, and how much of its length survived. */
  warnings: { figures: string[]; coverage: number; thin: boolean };
  renderedAt: string;
  cached: boolean;
  /**
   * Whether this layout is now in the store.
   *
   * Said out loud because the alternative is a feature that looks broken in exactly the way it was
   * complained about: with no table to write to, every reader pays for a fresh layout and the promise
   * that it is done once is quietly false. False here means the page tells somebody to run the migration
   * rather than leaving them to notice the bill.
   */
  stored: boolean;
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
  if (Number(warnings.version ?? 0) !== RENDER_VERSION) return null;
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
    stored: true,
  };
}

/**
 * Keeps a layout, and says whether it managed to.
 *
 * A failure here never fails the request — the reader has their page and the saving is for the next
 * person. But it is reported rather than swallowed, because the one failure that matters is the table
 * not existing, and that turns "laid out once" into "laid out on every open" with nothing on screen
 * to say so.
 */
async function keepRender(path: string, sha: string, render: BrainRender): Promise<boolean> {
  const held = store();
  const head = headers({ Prefer: "resolution=merge-duplicates,return=minimal" });
  if (!held || !head) return false;
  const response = await fetch(`${held.url}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: head,
    body: JSON.stringify({
      path,
      source_sha: sha,
      markdown: render.markdown,
      model: render.model,
      warnings: { ...render.warnings, version: RENDER_VERSION },
      rendered_at: new Date().toISOString(),
    }),
  }).catch(() => null);
  return response?.ok === true;
}

/**
 * Every layout already in the store that is still current: path to the SHA it was made from.
 *
 * The point of this is that deciding what still needs doing costs one request instead of one per
 * document. The repository listing already carries every file's blob SHA, so a walk over the whole
 * brain can work out its own backlog from two round trips and never fetch a file it is not about to
 * lay out. Rows written by an older prompt version are left out, which is what makes them get redone.
 *
 * An unreachable store returns an empty map — the caller then thinks everything needs rendering, which
 * is wrong but harmless: `renderBrainDoc` checks again per document and will not double-spend.
 */
export async function storedRenderShas(): Promise<Map<string, string>> {
  const held = store();
  const head = headers();
  const found = new Map<string, string>();
  if (!held || !head) return found;
  const query = `${TABLE}?select=path,source_sha,warnings&limit=5000`;
  const response = await fetch(`${held.url}/rest/v1/${query}`, { headers: head, cache: "no-store" }).catch(() => null);
  if (!response?.ok) return found;
  for (const row of ((await response.json().catch(() => [])) as Row[]) ?? []) {
    const warnings = (row.warnings && typeof row.warnings === "object" ? row.warnings : {}) as Row;
    if (Number(warnings.version ?? 0) !== RENDER_VERSION) continue;
    const path = String(row.path ?? "");
    const sha = String(row.source_sha ?? "");
    if (path && sha) found.set(path, sha);
  }
  return found;
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
 * What the model is told.
 *
 * ── Why this is written as a demand and not as a permission ─────────────────────────────────────
 * The first version of this prompt led with its prohibitions and offered the visuals as things the
 * model *may* use. The result was the source document with slightly better headings — put beside the
 * original it was hard to tell which was which. A model reading a page of "never do this" concludes,
 * correctly, that the safest output is the input, and safety is not what this feature is for.
 *
 * So the order is inverted. The mandate comes first and it is compulsory: pick the shapes the document
 * already is, and draw them. The prohibitions still follow, unchanged, because the failure they guard
 * against is worse than a dull layout — but they are guardrails on a job, not the job.
 *
 * ── Why the visual list is specific ─────────────────────────────────────────────────────────────
 * "Be more visual" gets a wall of bullets. Every fence named below is one the app already draws as CSS
 * — `Markdown.tsx` renders `stats`, `chart`, `map`, `cards` and `timeline` — so each line is a real
 * instruction with a real result rather than a hope. The mapping from prose shape to fence is spelled
 * out for the same reason: the model's difficulty is not drawing a table, it is noticing that the four
 * paragraphs in front of it were four personas all along.
 */
const SYSTEM = `You are given one markdown document from an internal agency knowledge base. It is correct, it is useful, and nobody reads it, because it is a wall of bold labels and nested bullets. Your job is to lay it out again so that somebody opening it can see what is in it in five seconds.

Reproducing the document with tidier headings is a failure. If your output could be mistaken for the input, you have not done the job. Restructure aggressively — the shapes are already in the text, and your task is to find them and draw them.

## Find these shapes and convert them, every time they appear

1. **Repeated things with the same attributes** — personas, tiers, competitors, tools, channels, segments, plans. These are a TABLE or a \`cards\` block. Never leave them as prose or as bullets.
2. **Any number the document states** — rates, counts, prices, headcounts, cycle lengths, quotas. The three to six that matter most go in a \`stats\` row near the top.
3. **Quantities the document compares** — reply rates across tracks, revenue by segment, volumes by month. That is a \`chart\`.
4. **Places** — states, regions, territory priorities, "we sell into X, Y and Z". That is a \`map\`.
5. **Anything ordered** — a cadence, an onboarding sequence, a sales stage list, a week-by-week plan, "first… then… finally". That is a \`timeline\`.
6. **The one or two lines that change what somebody does** — a rule, a hard no, a positioning sentence. Pull each into its own blockquote.
7. **Definitions and label/value pairs** — a two-column table.

Then give the document real headings in its own words, so the whole thing can be skimmed, and put a horizontal rule between major parts.

## The blocks you can draw

A fenced code block with one of these language tags renders as a visual. The body must be valid JSON on the lines after the tag.

\`stats\` — a row of headline figures. Values are strings copied exactly as the source writes them. Max six.
{"items":[{"label":"Reply rate","value":"24.2%","note":"ortho track"},{"label":"Avg deal","value":"$4,000"}]}

\`chart\` — type is "bar" (ranking), "column" (a few values side by side) or "split" (parts of one whole).
{"type":"bar","title":"Reply rate by track","unit":"%","series":[{"label":"Ortho","value":24.2},{"label":"Perio","value":11.8,"note":"paused"}]}

\`map\` — US states as tiles. Two-letter codes. tone is "strong" for priority, "cool" for secondary, "quiet" for excluded. Anything that is not a US state (a province, a country, a region name) goes in the same list and is listed beside the map.
{"title":"Where they sell","states":[{"code":"CA","tone":"strong"},{"code":"AZ","tone":"strong"},{"code":"NY","tone":"cool","note":"one account"}]}

\`cards\` — a grid of comparable things. Max eight, max six lines each.
{"title":"Personas","items":[{"title":"Practice owner","subtitle":"Decision maker","badge":"Primary","tone":"strong","lines":["Owns budget","Cares about chair time"]}]}

\`timeline\` — ordered steps.
{"title":"Outreach cadence","steps":[{"label":"Connection request","when":"Day 0","body":"No note."},{"label":"First message","when":"Day 2"}]}

## Rules that are not negotiable

- Every fact, name, number, place, bullet and caveat in the source must survive somewhere in your output. Restructuring is required; losing content is a failure.
- Add nothing. No new facts, no examples, no estimates, no averages, no totals you calculated, no advice, no commentary, no "note:" additions, no filler to balance a layout.
- Never change a number. Not its value, not its rounding, not its unit. 1,998 stays 1,998.
- Never invent a figure to complete a visual. If the document does not state the numbers a chart needs, do not draw that chart — draw a different shape instead. An empty slot in a layout is fine; a made-up number is not.
- Keep every campaign code (like CT50, WLW-Q3) exactly as written — other parts of the app match on them.
- Keep the document's own wording wherever it carries meaning. You may split a run-on line, promote a bold label to a heading, move a sentence into a table cell, and reorder sections so the summary is first. You may not paraphrase a definition or reword a rule.
- Bold only what was already a label. If everything is bold, nothing is.
- No HTML, and no images or logos — you have no URLs, and an invented one is a broken image.

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
    signal: AbortSignal.timeout(RENDER_TIMEOUT_MS),
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
    stored: false,
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
  const stored = await keepRender(path, sha, made);
  return { ...made, stored };
}
