/**
 * Reading the charts the assistant draws.
 *
 * An answer to "which campaign is doing best" is a ranking, and a ranking is easier to read as bars
 * than as a column of numbers. So the model is allowed to embed a visual in its answer by writing a
 * fenced block with a `chart` or `stats` language tag and a JSON body, and this module turns that body
 * into geometry the renderer can lay out directly.
 *
 * ── Why a fence rather than a tool ──────────────────────────────────────────────────────────────
 * A "draw a chart" tool would have to return something, and there is nothing useful to return — the
 * model does not need to see its own chart. Worse, a tool call happens *before* the prose is written,
 * so the chart would land wherever the loop happened to put it rather than where it belongs in the
 * argument. A fence sits exactly where the model wrote it, costs one block, and flows through the
 * markdown pipeline that already handles rendering, export and print.
 *
 * ── The rule that keeps a chart honest ──────────────────────────────────────────────────────────
 * Bars are measured from zero, always. Scaling a 24% and a 25% between a min and a max turns a
 * one-point difference into an empty bar beside a full one, which is a picture of a finding that does
 * not exist. Every other decision here is cosmetic; this one is the difference between illustrating
 * the answer and contradicting it.
 *
 * Anything malformed returns `null`, and the caller then renders the block as the code it literally
 * is. That is deliberately unglamorous: a broken spec shows up as visible JSON in the answer, which is
 * ugly enough to get fixed and honest enough not to invent a shape for data we could not read.
 */

/**
 * Bars past this many stop being a chart and start being a wall.
 *
 * The excess is counted and reported rather than dropped — the same call the report builder makes when
 * a selection overflows a page. A chart that quietly showed the top twelve of forty would be read as
 * the whole picture.
 */
const MAX_POINTS = 12;

const CHART_TYPES = new Set(["bar", "column", "split"]);

/**
 * The United States as a grid of equal tiles, west to east and north to south.
 *
 * Every ICP in the brain names territory — "CA, AZ, NV and TX", "the Northeast except NY" — and until
 * now that arrived as a comma-separated line you skim past. A tile map answers "where are we selling"
 * in one look, and a *tile* map rather than a real one for two reasons: an outline of the country is an
 * SVG asset with a projection and a licence, and, more usefully, equal tiles do not make Montana look
 * like the point and Rhode Island look like a rounding error.
 *
 * Read as text so the layout can be checked by looking at it. Twelve columns per row, `.` for water.
 */
const US_TILES = [
  "AK .  .  .  .  .  .  .  .  .  .  ME",
  ".  WA .  MT ND MN WI MI .  NY VT NH",
  ".  OR ID WY SD IA IL IN OH PA NJ MA",
  ".  CA NV UT CO NE MO KY WV VA MD CT",
  ".  .  AZ NM KS AR TN NC SC DC DE RI",
  ".  .  .  .  OK LA MS AL GA .  .  .",
  "HI .  .  .  TX .  .  .  .  FL .  .",
];

/** `{ CA: { row, column } }`, built once from the picture above. */
const US_GRID = (() => {
  const at = {};
  US_TILES.forEach((line, index) => {
    line
      .trim()
      .split(/\s+/)
      .forEach((code, column) => {
        if (code !== ".") at[code] = { row: index + 1, column: column + 1 };
      });
  });
  return at;
})();

export const US_COLUMNS = 12;
export const US_ROWS = US_TILES.length;

/** The tones a spec may ask for. Anything else is dropped rather than passed through to a CSS hook. */
const TONES = new Set(["strong", "warm", "cool", "quiet", "negative", "positive"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Accepts a real number or the string form of one, because a model emitting `"24.2"` is common. */
function numeric(value) {
  if (typeof value === "number") return finite(value);
  if (typeof value !== "string" || !value.trim()) return null;
  // Strips the unit the model sometimes leaves attached: "24.2%", "1,998", "$4,000".
  const cleaned = value.replace(/[,\s%$]/g, "");
  return finite(Number(cleaned));
}

/**
 * The number as it should be written on the chart.
 *
 * Counts keep their thousands separators and lose their decimals; rates keep one decimal, because
 * "24.2%" and "24%" answer different questions when two campaigns are a fraction of a point apart.
 */
export function formatValue(value, unit = "") {
  const suffix = unit === "%" ? "%" : unit ? ` ${unit}` : "";
  const decimals = unit === "%" || Math.abs(value) < 10 ? 1 : 0;
  const rounded = Number(value.toFixed(decimals));
  return `${rounded.toLocaleString("en-US", { maximumFractionDigits: decimals })}${suffix}`;
}

/**
 * One point, kept even when its value could not be read.
 *
 * A point we cannot parse becomes a labelled row with no bar and no number, rather than disappearing.
 * Dropping it would silently shorten a ranking, and a ranking missing a row is a wrong answer that
 * looks like a complete one.
 */
function point(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const value = numeric(item.value);
  return {
    label: text(item.label) || text(item.name) || "—",
    note: text(item.note),
    value,
    tone: text(item.tone),
  };
}

/**
 * Turns parsed points into fractions of the bar track.
 *
 * `split` divides a whole, so each part is measured against the sum. `bar` and `column` compare
 * separate quantities, so each is measured against the largest — from zero, per the note above.
 *
 * Negative values are scaled on magnitude and marked, which is what a week-over-week change needs.
 * A chart of all zeros yields all zeros rather than a division by zero, and renders as bare labels.
 */
function withFractions(points, chart) {
  const values = points.map((entry) => entry.value).filter((value) => value !== null);
  const total = values.reduce((sum, value) => sum + Math.abs(value), 0);
  const peak = Math.max(...values.map(Math.abs), 0);
  const basis = chart === "split" ? total : peak;
  return points.map((entry) => ({
    ...entry,
    fraction: entry.value === null || !basis ? 0 : Math.abs(entry.value) / basis,
    negative: entry.value !== null && entry.value < 0,
  }));
}

/**
 * A chart spec, or `null` if there is nothing here worth drawing.
 *
 * An unknown `type` falls back to `bar` rather than failing: the labels and numbers are the substance
 * and a horizontal ranking is the safest way to show any of them. An empty `series` is the one case
 * that returns null, because there is no honest way to draw no data.
 */
export function parseChart(body) {
  const spec = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const rows = Array.isArray(spec.series) ? spec.series : Array.isArray(spec.data) ? spec.data : [];
  if (!rows.length) return null;

  const requested = text(spec.type).toLowerCase();
  const chart = CHART_TYPES.has(requested) ? requested : "bar";
  const unit = text(spec.unit);
  const shown = rows.slice(0, MAX_POINTS).map(point);
  return {
    kind: "chart",
    chart,
    title: text(spec.title),
    caption: text(spec.caption) || text(spec.subtitle),
    unit,
    hidden: Math.max(0, rows.length - MAX_POINTS),
    series: withFractions(shown, chart).map((entry) => ({
      ...entry,
      display: entry.value === null ? "" : formatValue(entry.value, unit),
    })),
  };
}

/**
 * A row of headline figures.
 *
 * Values stay strings and are never reformatted. The model has already decided that the answer is
 * "24.2%" or "3 of 39" or "6 weeks", and re-deriving those from numbers would only introduce a second
 * opinion about a figure the prose underneath already commits to.
 */
export function parseStats(body) {
  const spec = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  // A bare array is accepted alongside `{items:[…]}`, because both are what the model reaches for.
  const rows = Array.isArray(body) ? body : Array.isArray(spec.items) ? spec.items : Array.isArray(spec.stats) ? spec.stats : [];
  const items = rows
    .map((raw) => {
      const item = raw && typeof raw === "object" ? raw : {};
      return {
        label: text(item.label) || text(item.name),
        value: typeof item.value === "number" ? String(item.value) : text(item.value),
        note: text(item.note),
        tone: text(item.tone),
      };
    })
    .filter((item) => item.label || item.value);
  // Six across is already tight in a chat column; past that they stop reading as headlines.
  return items.length ? { kind: "stats", items: items.slice(0, 6) } : null;
}

const tone = (value) => (TONES.has(text(value).toLowerCase()) ? text(value).toLowerCase() : "");

/**
 * A territory map: the states a document names, placed on the tile grid.
 *
 * States the grid does not know — provinces, countries, "EMEA" — are not dropped. They come back in
 * `elsewhere` and the renderer lists them beside the map, because a coverage picture missing Ontario is
 * a wrong answer that looks complete, and this file's whole position is that silence is the one thing a
 * visual may not do.
 */
export function parseMap(body) {
  const spec = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const rows = Array.isArray(body) ? body : Array.isArray(spec.states) ? spec.states : Array.isArray(spec.items) ? spec.items : [];
  const placed = [];
  const elsewhere = [];
  const seen = new Set();
  for (const raw of rows) {
    const item = raw && typeof raw === "object" ? raw : { code: raw };
    const code = text(item.code) || text(item.state) || text(item.label);
    const key = code.toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const entry = { code: key, note: text(item.note) || text(item.value), tone: tone(item.tone) };
    const spot = US_GRID[key];
    if (spot) placed.push({ ...entry, ...spot, label: text(item.label) && text(item.label) !== code ? text(item.label) : "" });
    else elsewhere.push({ ...entry, label: text(item.label) || code });
  }
  if (!placed.length && !elsewhere.length) return null;
  return {
    kind: "map",
    title: text(spec.title),
    caption: text(spec.caption) || text(spec.note),
    states: placed,
    elsewhere,
    columns: US_COLUMNS,
    rows: US_ROWS,
  };
}

/**
 * A row of cards: the personas, tiers or tracks a document defines.
 *
 * The shape a brain document reaches for most and formats worst — four personas as four runs of bold
 * label and nested bullets, which reads as one paragraph and gets skimmed as one. Three or four lines
 * per card, because a card that holds a paragraph is a paragraph with a border.
 */
export function parseCards(body) {
  const spec = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const rows = Array.isArray(body) ? body : Array.isArray(spec.items) ? spec.items : Array.isArray(spec.cards) ? spec.cards : [];
  const items = rows
    .map((raw) => {
      const item = raw && typeof raw === "object" ? raw : { title: raw };
      const lines = Array.isArray(item.lines) ? item.lines : Array.isArray(item.points) ? item.points : [];
      return {
        title: text(item.title) || text(item.label) || text(item.name),
        subtitle: text(item.subtitle) || text(item.role),
        badge: text(item.badge) || text(item.tag),
        tone: tone(item.tone),
        lines: lines.map((line) => (line && typeof line === "object" ? `${text(line.label)}: ${text(line.value)}` : text(line))).filter(Boolean).slice(0, 6),
      };
    })
    .filter((item) => item.title || item.lines.length);
  return items.length ? { kind: "cards", title: text(spec.title), items: items.slice(0, 8) } : null;
}

/**
 * An ordered sequence: a cadence, a stage list, an onboarding run.
 *
 * Numbered so the order is the point, and drawn down the page rather than across it, because these are
 * usually five to nine steps with a sentence each and a horizontal one would either wrap or truncate.
 */
export function parseTimeline(body) {
  const spec = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const rows = Array.isArray(body) ? body : Array.isArray(spec.steps) ? spec.steps : Array.isArray(spec.items) ? spec.items : [];
  const steps = rows
    .map((raw) => {
      const item = raw && typeof raw === "object" ? raw : { label: raw };
      return {
        label: text(item.label) || text(item.title) || text(item.name),
        when: text(item.when) || text(item.day) || text(item.date),
        body: text(item.body) || text(item.detail) || text(item.note),
        tone: tone(item.tone),
      };
    })
    .filter((step) => step.label || step.body);
  return steps.length ? { kind: "timeline", title: text(spec.title), steps: steps.slice(0, 12) } : null;
}

const READERS = { chart: parseChart, stats: parseStats, map: parseMap, cards: parseCards, timeline: parseTimeline };

/** The fence tags that render as something other than code, for the renderer's mid-stream placeholder. */
export const VISUAL_TAGS = Object.keys(READERS);

/**
 * Interprets a fenced block, or returns `null` to leave it as code.
 *
 * Called from the markdown parser, which owns the decision about what to do with the null: the answer
 * still renders, with the spec visible as the code it is.
 */
export function parseVisual(language, source) {
  const read = READERS[text(language).toLowerCase()];
  if (!read) return null;
  let body;
  try {
    body = JSON.parse(String(source ?? ""));
  } catch {
    return null;
  }
  return read(body);
}
