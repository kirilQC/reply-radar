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

/**
 * Interprets a fenced block, or returns `null` to leave it as code.
 *
 * Called from the markdown parser, which owns the decision about what to do with the null: the answer
 * still renders, with the spec visible as the code it is.
 */
export function parseVisual(language, source) {
  const tag = text(language).toLowerCase();
  if (tag !== "chart" && tag !== "stats") return null;
  let body;
  try {
    body = JSON.parse(String(source ?? ""));
  } catch {
    return null;
  }
  return tag === "chart" ? parseChart(body) : parseStats(body);
}
