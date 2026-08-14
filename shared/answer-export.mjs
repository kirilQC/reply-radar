/**
 * Turns an answer into a spreadsheet.
 *
 * People ask this thing to rank campaigns or list who needs following up, and then want that in a
 * sheet. The answer is markdown, so the tables in it are already the rows somebody wants — this
 * lifts them out rather than asking the model to produce a second machine-readable copy, which would
 * double the tokens and give two versions of the same numbers that could disagree.
 *
 * Charts export the same way, from the same principle: the bars were drawn from figures the answer
 * already committed to, so the file restates those rather than a second set.
 *
 * ── When there is neither ───────────────────────────────────────────────────────────────────────
 * A judgement — "CT50 is the strongest at meaningful volume" — has no rows in it. Exporting nothing
 * would look broken, and inventing a shape for prose would be worse, so the prose is written out as
 * single-column lines under a `Answer` header. It opens in a spreadsheet, it is obviously not a
 * table, and nothing is lost.
 *
 * The question and the timestamp always lead the file, because a sheet called `export.csv` with five
 * campaign names in it is unidentifiable a week later.
 */

import { parseBlocks, spansToText } from "./markdown-blocks.mjs";

/**
 * One CSV field, quoted per RFC 4180.
 *
 * Quoted whenever it contains a comma, a quote, a newline or leading whitespace — and quotes inside
 * are doubled. A campaign name like `CT001: RSA (Detection & Response)` has no comma, but a message
 * body pasted into a cell will, and one unquoted comma shifts every column after it.
 */
export function csvField(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const row = (fields) => fields.map(csvField).join(",");

/**
 * A grid that did not come from an answer.
 *
 * Separate from `answerToCsv` for a reason worth stating: an exported HeyReach lead list is fetched,
 * written and handed to the browser without the model ever seeing the rows. Two thousand people are
 * not something to spend context on, and more to the point a list retyped by a language model is not
 * the list — it is a very good imitation of it, and nobody looking at the file would be able to tell.
 */
export const rowsToCsv = (head, records) =>
  [row(head), ...(Array.isArray(records) ? records : []).map(row)].join("\n");

/**
 * The rows hidden inside a block, or `null` if it holds none.
 *
 * Charts count. The bars are drawn from real figures, and an answer that made its point with a chart
 * instead of a table would otherwise export as a paragraph — the numbers on screen, missing from the
 * file. The chart's own title becomes the header so stacked ranges stay identifiable.
 */
function gridOf(block) {
  if (block.kind === "table") return { head: block.head.map(spansToText), rows: block.rows.map((cells) => cells.map(spansToText)) };
  if (block.kind === "chart") {
    const notes = block.series.some((point) => point.note);
    return {
      title: block.title,
      head: notes ? ["Label", "Value", "Note"] : ["Label", "Value"],
      // The raw number, not the drawn one: a spreadsheet should get `24.2`, not `24.2%`.
      rows: block.series.map((point) => {
        const cells = [point.label, point.value === null ? "" : point.value];
        return notes ? [...cells, point.note] : cells;
      }),
    };
  }
  if (block.kind === "stats") return { head: ["Label", "Value", "Note"], rows: block.items.map((item) => [item.label, item.value, item.note]) };
  return null;
}

/**
 * Builds the CSV for one answer.
 *
 * `question` and `askedAt` are the provenance header. Multiple tables are written one after another
 * separated by a blank line, each under its own header row, which is what a spreadsheet does with
 * stacked ranges and is far more useful than merging tables that share no columns.
 */
export function answerToCsv({ question = "", answer = "", askedAt = "" } = {}) {
  const lines = [row(["Question", question]), row(["Asked", askedAt]), ""];
  const blocks = parseBlocks(answer);
  const grids = blocks.map(gridOf).filter(Boolean);

  if (grids.length) {
    grids.forEach((grid, index) => {
      if (index > 0) lines.push("");
      if (grid.title) lines.push(row([grid.title]));
      lines.push(row(grid.head));
      for (const cells of grid.rows) lines.push(row(cells));
    });
    return lines.join("\n");
  }

  lines.push(row(["Answer"]));
  for (const block of blocks) {
    if (block.kind === "paragraph" || block.kind === "heading" || block.kind === "callout") lines.push(row([spansToText(block.spans)]));
    else if (block.kind === "list") for (const item of block.items) lines.push(row([spansToText(item.spans)]));
    else if (block.kind === "code") for (const line of block.text.split("\n")) lines.push(row([line]));
  }
  return lines.join("\n");
}

/**
 * A filename that says what the file is.
 *
 * Built from the question because that is the only thing that distinguishes one export from another,
 * cut to six words so it stays readable in a Downloads folder, and stripped of everything a file
 * system or a shell would object to.
 */
export function exportFilename(question, askedAt, extension) {
  const slug = String(question ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  const day = String(askedAt ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  return `reply-radar-${slug || "answer"}-${day}.${extension}`;
}
