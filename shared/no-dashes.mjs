// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Em dashes and en dashes never reach a reader.
 *
 * The house rule is absolute: no `—` and no `–` in anything a person sees. Prompts ask the model not to
 * write them, but a prompt is a request, not a guarantee, so every AI feature runs its final text through
 * this before it is posted to Slack, shown in the app, or put in a report.
 *
 * - A dash between two numbers (or a time and a number) is a range: "10–20" and "5 PM – 8" become
 *   "10 to 20" and "5 PM to 8".
 * - A dash standing alone in a markdown table cell (an empty value) becomes "-".
 * - A dash opening a line, used as a bullet, becomes "- ".
 * - A dash followed only by punctuation or the end of a line is dropped.
 * - A spaced dash in prose ("this — that") becomes a comma: "this, that".
 * - Anything left (an unspaced "word—word") becomes a plain hyphen.
 *
 * Plain ESM with no imports, so the server routes, the worker and the browser can all share it.
 *
 * @param {string} input
 * @returns {string}
 */
export function stripDashes(input) {
  if (typeof input !== "string" || !/[—–]/.test(input)) return input;
  return (
    input
      // 10–20, 9 — 5, 5 AM – 8 PM
      .replace(/(\d|\b[AaPp]\.?[Mm]\.?)[ \t]*[—–][ \t]*(?=\d)/g, "$1 to ")
      // | — | an empty table cell
      .replace(/(\|[ \t]*)[—–]+([ \t]*)(?=\|)/g, "$1-$2")
      // a dash used as a bullet at the start of a line
      .replace(/(^|\n)([ \t]*)[—–][ \t]+/g, "$1$2- ")
      // a dash with nothing after it but punctuation or the end of the line adds nothing
      .replace(/(?<=\S)[ \t]*[—–]+[ \t]*(?=[,.;:!?)\]]|\r?\n|$)/g, "")
      // a spaced dash in prose
      .replace(/[ \t]*[—–]+[ \t]+|[ \t]+[—–]+[ \t]*/g, ", ")
      // anything left is unspaced
      .replace(/[—–]/g, "-")
  );
}

export default stripDashes;
