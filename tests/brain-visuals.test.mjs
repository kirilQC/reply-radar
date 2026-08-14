// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The three visuals added so a brain document stops being a wall of text.
 *
 * A map, a card grid and a step list are all the same bet: the shape is already in the document and
 * drawing it is what makes somebody read it. Which means the failure mode is the same one the charts
 * have — a picture that looks complete while quietly holding less than the prose it replaced. So most
 * of what is tested here is what happens to the awkward input: a state the grid has never heard of, a
 * bare array where an object was expected, a tone the CSS has no rule for, a list of forty.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { US_COLUMNS, US_ROWS, parseCards, parseMap, parseTimeline, parseVisual } from "../shared/answer-visuals.mjs";
import { parseBlocks } from "../shared/markdown-blocks.mjs";
import { answerHasRows, answerToCsv } from "../shared/answer-export.mjs";

/* ── The map ─────────────────────────────────────────────────────────────────────────────────── */

test("states land on the grid, west of each other in the order geography puts them", () => {
  const map = parseMap({ states: [{ code: "CA" }, { code: "TX" }, { code: "NY" }] });
  const at = Object.fromEntries(map.states.map((state) => [state.code, state]));
  assert.ok(at.CA.column < at.TX.column, "California is not west of Texas");
  assert.ok(at.TX.column < at.NY.column, "Texas is not west of New York");
  assert.ok(at.CA.row < at.TX.row, "California is not north of Texas");
  // Every tile has to be inside the grid the renderer sizes, or it silently starts a new row.
  for (const state of map.states) {
    assert.ok(state.column >= 1 && state.column <= US_COLUMNS, `${state.code} is off the grid`);
    assert.ok(state.row >= 1 && state.row <= US_ROWS, `${state.code} is off the grid`);
  }
});

test("every state and DC has a tile, and no two share one", () => {
  const codes = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
  const map = parseMap({ states: codes.map((code) => ({ code })) });
  assert.equal(map.elsewhere.length, 0, `no tile for: ${map.elsewhere.map((place) => place.code).join(", ")}`);
  const seats = new Set(map.states.map((state) => `${state.row}:${state.column}`));
  assert.equal(seats.size, codes.length, "two states are sitting on the same tile");
});

test("somewhere the grid does not know is listed, never dropped", () => {
  // The failure this exists to prevent: a coverage map missing Ontario reads as a complete one.
  const map = parseMap({ states: [{ code: "CA" }, { code: "ON", label: "Ontario" }, { code: "EMEA" }] });
  assert.deepEqual(
    map.states.map((state) => state.code),
    ["CA"],
  );
  assert.deepEqual(
    map.elsewhere.map((place) => place.label),
    ["Ontario", "EMEA"],
  );
});

test("lower case and a bare array of codes both work", () => {
  const map = parseMap(["ca", "az"]);
  assert.deepEqual(
    map.states.map((state) => state.code),
    ["CA", "AZ"],
  );
});

test("the same state twice is one tile", () => {
  const map = parseMap({ states: [{ code: "CA", tone: "strong" }, { code: "CA" }] });
  assert.equal(map.states.length, 1);
  assert.equal(map.states[0].tone, "strong", "the first mention should win");
});

test("a tone the stylesheet has no rule for is dropped rather than passed through", () => {
  const map = parseMap({ states: [{ code: "CA", tone: "screaming-red" }] });
  assert.equal(map.states[0].tone, "");
});

test("an empty map is nothing to draw", () => {
  assert.equal(parseMap({ states: [] }), null);
  assert.equal(parseMap({}), null);
});

/* ── Cards ───────────────────────────────────────────────────────────────────────────────────── */

test("cards keep their lines and cap at eight", () => {
  const cards = parseCards({
    title: "Personas",
    items: Array.from({ length: 11 }, (unused, index) => ({ title: `Persona ${index}`, lines: ["one", "two"] })),
  });
  assert.equal(cards.title, "Personas");
  assert.equal(cards.items.length, 8);
  assert.deepEqual(cards.items[0].lines, ["one", "two"]);
});

test("a line written as a label/value pair reads as one", () => {
  const cards = parseCards([{ title: "Owner", lines: [{ label: "Budget", value: "$4,000" }] }]);
  assert.deepEqual(cards.items[0].lines, ["Budget: $4,000"]);
});

test("a card with only lines survives, a card with nothing at all does not", () => {
  const cards = parseCards([{ lines: ["owns the budget"] }, {}, { title: "" }]);
  assert.equal(cards.items.length, 1);
  assert.equal(parseCards([{}]), null);
});

/* ── Steps ───────────────────────────────────────────────────────────────────────────────────── */

test("steps keep their order and their timings", () => {
  const steps = parseTimeline({
    title: "Cadence",
    steps: [
      { label: "Connection request", when: "Day 0" },
      { label: "First message", when: "Day 2", body: "No pitch." },
    ],
  });
  assert.deepEqual(
    steps.steps.map((step) => step.label),
    ["Connection request", "First message"],
  );
  assert.equal(steps.steps[1].when, "Day 2");
  assert.equal(steps.steps[1].body, "No pitch.");
});

test("a step written as a bare string is still a step", () => {
  const steps = parseTimeline(["Send the connection request", "Wait two days"]);
  assert.equal(steps.steps.length, 2);
  assert.equal(steps.steps[0].label, "Send the connection request");
});

/* ── Through the markdown pipeline ───────────────────────────────────────────────────────────── */

test("each new fence becomes its block, and a broken one stays visible code", () => {
  for (const tag of ["map", "cards", "timeline"]) {
    const body = { map: '{"states":["CA"]}', cards: '{"items":[{"title":"Owner"}]}', timeline: '{"steps":["Day 0"]}' }[tag];
    const [block] = parseBlocks(`\`\`\`${tag}\n${body}\n\`\`\``);
    assert.equal(block.kind, tag, `${tag} did not parse`);
    const [broken] = parseBlocks(`\`\`\`${tag}\n{"states":[\n\`\`\``);
    assert.equal(broken.kind, "code", `a malformed ${tag} should stay code rather than take the page down`);
  }
});

test("an unknown fence is still left alone", () => {
  assert.equal(parseVisual("python", "print(1)"), null);
});

/* ── Export ──────────────────────────────────────────────────────────────────────────────────── */

test("what is on the screen is in the file", () => {
  // A layout whose substance is a card grid used to export as an empty paragraph.
  const answer = ['```cards', '{"title":"Personas","items":[{"title":"Practice owner","subtitle":"Buyer","lines":["Owns budget"]}]}', "```"].join("\n");
  assert.equal(answerHasRows(answer), true);
  const csv = answerToCsv({ answer });
  assert.match(csv, /Title,Subtitle,Tag,Detail/);
  assert.match(csv, /Practice owner,Buyer,,Owns budget/);
});

test("a map exports its places, including the ones off the grid", () => {
  const answer = ['```map', '{"states":[{"code":"CA","note":"priority"},{"code":"ON","label":"Ontario"}]}', "```"].join("\n");
  const csv = answerToCsv({ answer });
  assert.match(csv, /CA,priority/);
  assert.match(csv, /Ontario/);
});
