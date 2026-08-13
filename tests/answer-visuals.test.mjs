/**
 * A chart that is merely ugly gets fixed. A chart that is wrong gets believed.
 *
 * Everything here is about the second kind. The bar lengths are the argument the answer is making, so
 * a scale that starts anywhere but zero, a ranking quietly cut to its top few, or a point dropped
 * because its value would not parse all produce a picture that contradicts the prose beside it while
 * looking entirely finished.
 *
 * The specs below are the shapes a model actually emits, including the sloppy ones: numbers as
 * strings, a percent sign left on, `data` instead of `series`, a type nobody defined.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatValue, parseChart, parseStats, parseVisual } from "../shared/answer-visuals.mjs";
import { parseBlocks } from "../shared/markdown-blocks.mjs";
import { answerToCsv } from "../shared/answer-export.mjs";

const chart = (series, extra = {}) => parseChart({ type: "bar", series, ...extra });

test("bars are measured from zero, not from the smallest value", () => {
  // The whole point. Two campaigns a point apart are two nearly equal bars; scaled between min and
  // max they would be an empty bar beside a full one, which is a finding that does not exist.
  const { series } = chart([
    { label: "CT050", value: 25 },
    { label: "CT049", value: 24 },
  ]);
  assert.equal(series[0].fraction, 1);
  assert.ok(series[1].fraction > 0.95, "a one-point gap must not render as a large one");
});

test("a split is measured against the total, not the largest part", () => {
  const { series } = parseChart({
    type: "split",
    series: [
      { label: "Positive", value: 30 },
      { label: "Neutral", value: 50 },
      { label: "Negative", value: 20 },
    ],
  });
  assert.deepEqual(
    series.map((point) => point.fraction),
    [0.3, 0.5, 0.2],
  );
});

test("a point whose value cannot be read keeps its label instead of vanishing", () => {
  // Dropping it would silently shorten a ranking, and a ranking missing a row looks complete.
  const { series } = chart([
    { label: "CT050", value: 25 },
    { label: "CT051", value: "unknown" },
  ]);
  assert.equal(series.length, 2);
  assert.equal(series[1].label, "CT051");
  assert.equal(series[1].value, null);
  assert.equal(series[1].fraction, 0);
  assert.equal(series[1].display, "", "no number is better than a made-up zero");
});

test("numbers written as strings, with units still attached, are read as numbers", () => {
  const { series } = chart([
    { label: "Reply rate", value: "24.2%" },
    { label: "Messages", value: "1,998" },
  ]);
  assert.equal(series[0].value, 24.2);
  assert.equal(series[1].value, 1998);
});

test("all-zero data draws no bars rather than dividing by zero", () => {
  const { series } = chart([
    { label: "CT050", value: 0 },
    { label: "CT051", value: 0 },
  ]);
  assert.deepEqual(series.map((point) => point.fraction), [0, 0]);
  assert.equal(series[0].display, "0");
});

test("negatives are scaled on magnitude and marked", () => {
  const { series } = chart([
    { label: "This week", value: 40 },
    { label: "Change", value: -20 },
  ]);
  assert.equal(series[1].fraction, 0.5);
  assert.equal(series[1].negative, true);
  assert.equal(series[0].negative, false);
});

test("a long ranking is cut, and says so", () => {
  // Silence here is the failure: a top-twelve presented as the whole list answers a different
  // question than the one asked.
  const series = Array.from({ length: 40 }, (_, index) => ({ label: `C${index}`, value: 40 - index }));
  const parsed = chart(series);
  assert.equal(parsed.series.length, 12);
  assert.equal(parsed.hidden, 28);
});

test("an unknown chart type falls back to bars instead of failing", () => {
  const parsed = parseChart({ type: "sunburst", series: [{ label: "a", value: 1 }] });
  assert.equal(parsed.chart, "bar");
});

test("a chart with no data is not a chart", () => {
  assert.equal(parseChart({ type: "bar", series: [] }), null);
  assert.equal(parseChart({ type: "bar" }), null);
  assert.equal(parseChart(null), null);
});

test("series may also arrive as `data`", () => {
  assert.equal(parseChart({ type: "column", data: [{ label: "Mon", value: 4 }] }).series.length, 1);
});

test("rates keep a decimal, counts do not", () => {
  // "24.2%" and "24%" are different answers when two campaigns are a fraction of a point apart.
  assert.equal(formatValue(24.24, "%"), "24.2%");
  assert.equal(formatValue(1998.4, ""), "1,998");
  assert.equal(formatValue(4, ""), "4");
  assert.equal(formatValue(3.5, "replies"), "3.5 replies");
});

test("stats keep the model's own wording for a value", () => {
  // Re-deriving "3 of 39" from a number would invent a second opinion about a figure the prose has
  // already committed to.
  const { items } = parseStats({ items: [{ label: "Campaigns live", value: "3 of 39", note: "Cotool" }] });
  assert.deepEqual(items[0], { label: "Campaigns live", value: "3 of 39", note: "Cotool", tone: "" });
});

test("stats accept a bare array and are capped at six", () => {
  assert.equal(parseStats([{ label: "a", value: "1" }]).items.length, 1);
  assert.equal(parseStats(Array.from({ length: 9 }, () => ({ label: "a", value: "1" }))).items.length, 6);
  assert.equal(parseStats([]), null);
});

test("a chart fence in an answer becomes a chart block", () => {
  const blocks = parseBlocks(
    [
      "Cotool's ranking:",
      "",
      "```chart",
      '{"type":"bar","title":"Reply rate","unit":"%","series":[{"label":"CT050","value":12.5}]}',
      "```",
      "",
      "CT050 leads on volume too.",
    ].join("\n"),
  );
  assert.deepEqual(blocks.map((block) => block.kind), ["paragraph", "chart", "paragraph"]);
  assert.equal(blocks[1].title, "Reply rate");
  assert.equal(blocks[1].series[0].display, "12.5%");
});

test("a malformed spec stays visible as code instead of taking the answer down", () => {
  const blocks = parseBlocks(["```chart", "{not json", "```", "", "The answer still renders."].join("\n"));
  assert.equal(blocks[0].kind, "code");
  assert.equal(blocks[0].language, "chart");
  assert.equal(blocks[1].kind, "paragraph");
});

test("a half-arrived chart is marked unclosed so the stream can hide it", () => {
  // Mid-stream the closing fence has not landed and the spec is invalid JSON. Without this flag the
  // reader watches raw JSON scroll past for a second before it snaps into a chart.
  const [block] = parseBlocks('```chart\n{"type":"bar","series":[{"label":"CT0');
  assert.equal(block.kind, "code");
  assert.equal(block.closed, false);
  // Once the fence closes, it is a finished spec and judged as one.
  assert.equal(parseBlocks('```chart\n{"broken"\n```')[0].closed, true);
});

test("an ordinary code fence is untouched", () => {
  assert.equal(parseVisual("json", '{"a":1}'), null);
  assert.equal(parseBlocks('```json\n{"a":1}\n```')[0].kind, "code");
});

test("a quoted line becomes a callout, and a blank line ends it", () => {
  const blocks = parseBlocks("> CT050 leads.\n> On real volume.\n\n> A second finding.");
  assert.deepEqual(blocks.map((block) => block.kind), ["callout", "callout"]);
  assert.equal(blocks[0].spans.map((span) => span.text).join(""), "CT050 leads. On real volume.");
});

test("prose after a callout stays a separate paragraph, in order", () => {
  const blocks = parseBlocks("> The finding.\nThe explanation.");
  assert.deepEqual(blocks.map((block) => block.kind), ["callout", "paragraph"]);
});

test("an answer that charts instead of tabulating still exports its numbers", () => {
  // Otherwise the file is a paragraph and the figures on screen are missing from it.
  const csv = answerToCsv({
    question: "Best campaign?",
    askedAt: "2026-08-13T10:00:00.000Z",
    answer: '```chart\n{"type":"bar","title":"Reply rate","unit":"%","series":[{"label":"CT050","value":12.5,"note":"48 convos"}]}\n```',
  });
  assert.match(csv, /Reply rate/);
  assert.match(csv, /Label,Value,Note/);
  // The raw number, not the drawn one — a spreadsheet cannot add up "12.5%".
  assert.match(csv, /CT050,12\.5,48 convos/);
});

test("a table still wins the export, and a chart beside it stacks", () => {
  const csv = answerToCsv({
    answer: [
      "| Campaign | Replies |",
      "| --- | --- |",
      "| CT050 | 12 |",
      "",
      '```chart',
      '{"type":"bar","series":[{"label":"CT050","value":12}]}',
      "```",
    ].join("\n"),
  });
  const blocks = csv.split("\n\n");
  assert.match(blocks[1], /Campaign,Replies/);
  assert.match(blocks[2], /Label,Value/);
});
