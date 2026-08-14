/**
 * Checking a re-laid-out brain document against the one it came from.
 *
 * ── What this is for ────────────────────────────────────────────────────────────────────────────
 * The brain's documents are written as plain prose and nobody reads them, so the app asks a model to
 * lay one out again — headings, tables, a row of figures, a bar chart where the document is already
 * comparing things. That is genuinely useful and it is also the single most dangerous thing in this
 * codebase, because a rewritten ICP that looks handsome is trusted more than the paragraph it
 * replaced, and a model asked to "make this visual" will happily draw a chart it needed one more
 * number to draw.
 *
 * So the redesign is never taken on trust. The instruction not to invent is in the prompt, and this
 * module is the part that checks, because a rule nobody verifies is a hope.
 *
 * ── Why figures, and only figures ───────────────────────────────────────────────────────────────
 * Prose cannot be diffed usefully: reordering a sentence, splitting a paragraph into two bullets and
 * turning "we target ASCs in CA, AZ and FL" into three table rows are all legitimate and all look
 * like edits. Numbers are different. A figure in the layout that is nowhere in the source is either
 * invented or computed, and both are things a reader must be told about — it is the one class of
 * fabrication that is both likely and mechanically detectable.
 *
 * The other half is the opposite failure: a model that summarises instead of reformatting produces
 * something shorter, cleaner and missing the third of the document nobody will notice is gone. Length
 * is a crude proxy and a sufficient one, because reformatting the same facts cannot lose half the
 * words.
 *
 * Neither check blocks the render. They travel with it to the page, which says so and keeps the
 * original one click away — the honest response to "this might have drifted" is to show the reader
 * both, not to silently pick one.
 */

/**
 * The figures worth checking.
 *
 * Two-digit numbers, anything with a decimal point, and anything wearing a `%`, `$` or a scale
 * suffix. Bare single digits are skipped deliberately: they are mostly ordinals the layout itself
 * introduces — a numbered list, "Track 1", a step count — and flagging those would bury the one real
 * finding under noise on every document.
 */
const UNIT = String.raw`\s*(?:%|[kKmMbB]\b)?`;
const FIGURE = new RegExp(
  [
    // Money, which is a figure at any length: "$40,000", "$4.5m", "$9".
    String.raw`\$\d[\d,]*(?:\.\d+)?${UNIT}`,
    // A decimal, likewise: "24.2%", "1.5".
    String.raw`\d[\d,]*\.\d+${UNIT}`,
    // A single digit wearing a unit is a quantity rather than an ordinal: "9%", "4k".
    String.raw`\d[\d,]*\s*(?:%|[kKmMbB]\b)`,
    // Anything else has to be two digits or more, which is the line between a figure and a list item.
    String.raw`\d[\d,]*\d`,
  ].join("|"),
  "g",
);

const LIST_MARKER = /^(\s*)\d{1,3}[.)]\s+/gm;
/** The tags a model uses when it wraps a whole document in a fence out of habit. */
const WRAPPER = /^\s*```(markdown|md)?\s*$/i;
const CLOSING = /^\s*```\s*$/;

/**
 * A figure reduced to the quantity it names, so the same number written two ways still matches.
 *
 * "1,998" and "1998" are the same figure; so are "24.20%" and "24.2%". The unit is dropped for the
 * comparison because a document saying "24.2" and a layout labelling it "24.2%" has added a unit,
 * which is a reading of the source rather than a new fact — and treating it as fabrication would make
 * the check cry wolf on exactly the documents it is meant to protect.
 */
function quantity(token) {
  const bare = String(token).replace(/[$,%\s]/g, "");
  const scale = /([kmb])$/i.exec(bare);
  const number = Number(scale ? bare.slice(0, -1) : bare);
  if (!Number.isFinite(number)) return "";
  const multiplier = scale ? { k: 1e3, m: 1e6, b: 1e9 }[scale[1].toLowerCase()] : 1;
  return String(number * multiplier);
}

/** Every figure in a piece of text, as the quantities they name. */
export function figuresIn(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(FIGURE)) {
    const value = quantity(match[0]);
    if (value) found.add(value);
  }
  return found;
}

/**
 * Strips a wrapping code fence, which is how a model returns "here is a markdown document".
 *
 * Only a `markdown`, `md` or untagged fence around the whole answer, and only when the fences inside
 * it balance. A document that opens with a chart spec also starts and ends with a fence, and stripping
 * that pair would leave the spec's JSON on the page as text and lose the chart it was going to draw.
 */
export function cleanRender(text) {
  const body = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const lines = body.split("\n");
  if (lines.length > 2 && WRAPPER.test(lines[0]) && CLOSING.test(lines.at(-1))) {
    const inner = lines.slice(1, -1);
    // Balanced fences inside mean the outer pair was the wrapper. An odd count means the first line
    // was itself the start of a real block.
    const fences = inner.filter((line) => /^\s*```/.test(line)).length;
    if (fences % 2 === 0) return inner.join("\n").trim();
  }
  return body;
}

/** Words, for the length comparison. Fences are counted too: a chart is content, not decoration. */
const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;

/**
 * What is different about the layout, in the only two ways that can be measured.
 *
 * `figures` are quantities the layout states and the source does not — invented, computed, or a
 * rounding the source never committed to. `coverage` is how much of the source's length survived;
 * `thin` is the call that it did not survive enough, at a threshold low enough that only a genuine
 * summary trips it.
 */
export function checkRender(source, rendered) {
  const from = figuresIn(source);
  // List markers are stripped from the layout side only. Turning six bullets into a numbered list is
  // the most ordinary reformat there is and it introduces 1 through 6 out of nothing.
  const clean = String(rendered ?? "").replace(LIST_MARKER, "$1");
  const invented = [];
  const seen = new Set();
  for (const match of clean.matchAll(FIGURE)) {
    const value = quantity(match[0]);
    if (!value || from.has(value) || seen.has(value)) continue;
    seen.add(value);
    invented.push(match[0].trim());
  }

  const before = words(source);
  const after = words(rendered);
  const coverage = before ? after / before : 1;
  return { figures: invented.slice(0, 8), coverage, thin: before > 120 && coverage < 0.55 };
}
