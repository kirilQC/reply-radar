// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Packing report sections onto a fixed number of printed pages.
 *
 * A client report must never exceed three pages. Templates satisfy that by declaring their page
 * layout, but "Build your own" lets someone tick thirteen sections, so the packing has to be computed
 * — and it has to be computed the same way the document renders, or the number shown next to the
 * export button is a guess.
 *
 * The approach is a weight per section rather than measuring the DOM. Measuring is tempting because it
 * sounds exact, but it is only exact for the data currently on screen: a client with two campaigns and
 * a client with forty produce different heights from the same section list, so the answer would change
 * between clients and the limit would be unpredictable. Weights make the layout a property of the
 * chosen sections alone, which is what someone ticking boxes is actually choosing.
 *
 * Lives in shared/ as plain ESM so the page and the test suite can both use it — the worker convention
 * in this repo, for the same reason: tests are .mjs and cannot import TypeScript.
 */

/**
 * Hard product limit. Three pages get read; ten do not.
 *
 * Content pages. A printed report also opens with a cover sheet, which is not counted here because it is
 * not a choice — every PDF gets one whatever the layout says, so it can no more push a selection over the
 * limit than the paper can.
 */
export const PAGE_LIMIT = 3;

/**
 * Usable vertical space on one page, in the same arbitrary units as SECTION_WEIGHTS.
 *
 * Calibrated against the rendered document at 8.5x11in with 0.75in margins, where a KPI grid occupies
 * roughly a third of the page. The absolute scale does not matter; only the ratio between this and the
 * weights below.
 *
 * 12 specifically, because that is the smallest capacity under which the built-in template's own
 * hand-designed three-page layout is feasible. That layout is the only ground truth available for how
 * much really fits on a page, so it is what the model is fitted to — otherwise the meter would report
 * four pages for a document that demonstrably renders in three.
 */
export const PAGE_CAPACITY = 12;

/**
 * How much of a page each section takes.
 *
 * Tables are weighted for their realistic length, not their maximum: campaigns and senders are capped
 * at 12 rows by the renderer, top leads at 15, and a full-length table is the common case for an
 * all-time report.
 */
export const SECTION_WEIGHTS = {
  // One line, and one line is all the box invites. Costed above zero anyway because it still carries a
  // section heading, which is most of what it occupies.
  intro: 1,
  // Written sections are costed for the length people actually type into a box that size: a paragraph
  // for the recap and the close, a handful of one-liners for the two lists. Someone who writes an essay
  // will overflow, which the meter cannot know in advance and the print preview will show.
  recap: 4,
  "executive-summary": 4,
  // Six figures with their denominators spelled out, so a little more than the KPI grid.
  metrics: 4,
  kpis: 3,
  sentiment: 3,
  trend: 3,
  // Costed above the reply-derived campaign table despite listing the same campaigns: this one can carry
  // eight columns, one of which is a list of sender names that wraps, so its rows are taller than a row of
  // figures. It was 4, and at 4 it clipped off the bottom of the page.
  "active-campaigns": 5,
  campaigns: 4,
  // A handful of one-liners, so it costs what the other typed lists cost less the paragraph.
  "booked-meetings": 3,
  // Five quotes, but each is a name line and a sentence or two rather than the full attribution block
  // that `sample-replies` prints — hence cheaper than that section despite covering the same ground.
  "best-replies": 5,
  senders: 4,
  "top-leads": 5,
  "icp-distribution": 2,
  "hot-conversations": 6,
  "reply-timing": 3,
  "sample-replies": 6,
  "what-we-did": 4,
  // One line per deal, and a client with more than five or six live deals from us is not the common case.
  "deal-progress": 4,
  priorities: 4,
  "warm-close": 2,
};

/**
 * Derived from the weights table rather than written out again, so the two cannot drift. TypeScript
 * callers get the exact union, and adding a section without a weight becomes a type error there.
 *
 * @typedef {keyof typeof SECTION_WEIGHTS} SectionId
 */

/** @param {SectionId} section @returns {number} */
export const weightOf = (section) => SECTION_WEIGHTS[section] ?? 3;

/**
 * Greedily fills one page before starting the next, preserving the order sections were given in.
 *
 * Order is preserved rather than optimised because the sequence is editorial — the opening line comes
 * first and the sign-off comes last, and a bin-packer that reorders sections to save a page would produce
 * a tidier number and a worse document. A section heavier than a whole page still gets its own page
 * rather than being dropped.
 *
 * Returns every page needed, which may exceed PAGE_LIMIT — deciding what to do about that belongs to
 * the caller, which can then say "this is 5 pages, trim 2" instead of silently truncating.
 *
 * @param {SectionId[]} sections
 * @returns {SectionId[][]}
 */
export function packPages(sections) {
  /** @type {SectionId[][]} */
  const pages = [];
  let current = [];
  let used = 0;

  for (const section of sections) {
    const weight = weightOf(section);
    if (current.length && used + weight > PAGE_CAPACITY) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(section);
    used += weight;
  }
  if (current.length) pages.push(current);
  return pages;
}

/**
 * Everything the UI needs to describe the current selection: the layout, the page count, and whether
 * it is over the limit.
 *
 * @param {SectionId[]} sections
 * @returns {{ pages: SectionId[][], pageCount: number, withinLimit: boolean, overflowPages: number }}
 */
export function paginate(sections) {
  const pages = packPages(sections);
  return {
    pages,
    pageCount: pages.length,
    withinLimit: pages.length <= PAGE_LIMIT,
    overflowPages: Math.max(0, pages.length - PAGE_LIMIT),
  };
}

/**
 * The sections to drop, heaviest-first, to bring a selection back inside the limit.
 *
 * Heaviest-first so the fewest removals get the biggest saving, and it never suggests dropping the opening
 * line or the executive summary — between them they are what makes the document a report rather than a
 * pile of tables, and a reader who only gets as far as page one has read them both.
 *
 * @param {SectionId[]} sections
 * @returns {SectionId[]}
 */
export function suggestTrim(sections) {
  const protected_ = new Set(["intro", "executive-summary"]);
  const { withinLimit } = paginate(sections);
  if (withinLimit) return [];

  const candidates = sections
    .filter((section) => !protected_.has(section))
    .sort((a, b) => weightOf(b) - weightOf(a));

  const trim = [];
  let remaining = sections.slice();
  for (const candidate of candidates) {
    remaining = remaining.filter((section) => section !== candidate);
    trim.push(candidate);
    if (paginate(remaining).withinLimit) break;
  }
  return trim;
}
