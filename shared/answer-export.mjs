/**
 * Turns an answer into a spreadsheet.
 *
 * People ask this thing to rank campaigns or list who needs following up, and then want that in a
 * sheet. The answer is markdown, so the tables in it are already the rows somebody wants — this
 * lifts them out rather than asking the model to produce a second machine-readable copy, which would
 * double the tokens and give two versions of the same numbers that could disagree.
 *
 * ── When there is no table ──────────────────────────────────────────────────────────────────────
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
 * Builds the CSV for one answer.
 *
 * `question` and `askedAt` are the provenance header. Multiple tables are written one after another
 * separated by a blank line, each under its own header row, which is what a spreadsheet does with
 * stacked ranges and is far more useful than merging tables that share no columns.
 */
export function answerToCsv({ question = "", answer = "", askedAt = "" } = {}) {
  const lines = [row(["Question", question]), row(["Asked", askedAt]), ""];
  const blocks = parseBlocks(answer);
  const tables = blocks.filter((block) => block.kind === "table");

  if (tables.length) {
    tables.forEach((table, index) => {
      if (index > 0) lines.push("");
      lines.push(row(table.head.map(spansToText)));
      for (const cells of table.rows) lines.push(row(cells.map(spansToText)));
    });
    return lines.join("\n");
  }

  lines.push(row(["Answer"]));
  for (const block of blocks) {
    if (block.kind === "paragraph" || block.kind === "heading") lines.push(row([spansToText(block.spans)]));
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
