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

/** Hard product limit. Three pages get read; ten do not. */
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
  cover: 3,
  "executive-summary": 4,
  kpis: 3,
  sentiment: 3,
  trend: 3,
  // Fewer than ten campaigns run at once, so this table is short by nature — but it carries five
  // columns and a caption, which costs about what the reply-derived campaign table costs.
  "active-campaigns": 4,
  campaigns: 4,
  senders: 4,
  "top-leads": 5,
  "icp-distribution": 2,
  "hot-conversations": 6,
  "reply-timing": 3,
  "sample-replies": 6,
  methodology: 2,
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
 * Order is preserved rather than optimised because the sequence is editorial — the cover comes first
 * and methodology comes last, and a bin-packer that reorders sections to save a page would produce a
 * tidier number and a worse document. A section heavier than a whole page still gets its own page
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
 * Heaviest-first so the fewest removals get the biggest saving, and it never suggests dropping the
 * cover, the executive summary or the methodology note — the first two are what makes the document a
 * report and the third is what makes its numbers defensible.
 *
 * @param {SectionId[]} sections
 * @returns {SectionId[]}
 */
export function suggestTrim(sections) {
  const protected_ = new Set(["cover", "executive-summary", "methodology"]);
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
