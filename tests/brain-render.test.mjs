/**
 * The guard on the redesigned brain documents.
 *
 * A model is asked to lay a client's ICP out again, and the output is shown to the people who decide
 * who we contact. If it quietly adds a number, the number is believed — it arrives in a nicely set
 * table, in a document that was already the source of truth, with nothing to distinguish it from the
 * facts around it. So the two failures that matter are tested directly here: a figure that was not in
 * the source, and a "layout" that is really a summary.
 *
 * The cases that would make the check useless are as important as the ones that make it work. A
 * numbered list, a percent sign added to a bare rate, and a thousands separator are all ordinary
 * reformats, and a checker that flagged them would be turned off within a day.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { checkRender, cleanRender, figuresIn } from "../shared/brain-render.mjs";

const SOURCE = `# Bluevia Health ICP

Two-track market: ASCs and Hospital Periop.

- Physician-owned ASCs, 4 or more operating rooms
- Geographic priority: CA, AZ, FL, NJ
- Reply rate on the ortho track was 24.2% across 1,998 invites
- Contract value around $40k
`;

test("a figure the source never states is reported", () => {
  const { figures } = checkRender(SOURCE, "Reply rate was 24.2% and meetings booked were 37.");
  assert.deepEqual(figures, ["37"]);
});

test("figures the source does state are left alone, however they are written", () => {
  // "1998" for "1,998" and "24.2" for "24.2%": the same quantities, punctuated differently.
  const { figures } = checkRender(SOURCE, "24.2 percent of 1998 invites, at $40k a contract.");
  assert.deepEqual(figures, []);
});

test("a percent sign added to a bare rate is not fabrication", () => {
  const { figures } = checkRender("Reply rate: 24.2 on the ortho track.", "**Reply rate** 24.2%");
  assert.deepEqual(figures, []);
});

test("turning bullets into a numbered list does not invent 1, 2 and 3", () => {
  const source = "- Physician owner\n- Practice administrator\n- Charge nurse\n";
  const { figures } = checkRender(source, "1. Physician owner\n2. Practice administrator\n3. Charge nurse\n");
  assert.deepEqual(figures, []);
});

test("single digits are never reported, because the layout is full of them", () => {
  const { figures } = checkRender("We target ASCs.", "## Track 1\n\nStep 3 of 4.");
  assert.deepEqual(figures, []);
});

test("a scale suffix is read as the quantity it means", () => {
  assert.ok(figuresIn("Contracts run to $40,000").has("40000"));
  assert.deepEqual(checkRender("Contracts run to $40,000", "Contract value $40k").figures, []);
});

test("only the first handful of invented figures are reported", () => {
  const invented = Array.from({ length: 20 }, (_, index) => `${(index + 11) * 3}%`).join(" ");
  assert.equal(checkRender("No numbers here.", invented).figures.length, 8);
});

test("a summary rather than a layout is caught by how little of it is left", () => {
  const source = Array.from({ length: 200 }, (_, index) => `fact${index}`).join(" ");
  const summary = source.split(" ").slice(0, 40).join(" ");
  const { thin, coverage } = checkRender(source, summary);
  assert.equal(thin, true);
  assert.ok(coverage < 0.3);
});

test("a real reformat grows the document and is not called thin", () => {
  const source = Array.from({ length: 200 }, (_, index) => `fact${index}`).join(" ");
  const { thin, coverage } = checkRender(source, `## Heading\n\n${source}`);
  assert.equal(thin, false);
  assert.ok(coverage >= 1);
});

test("a short document is never called thin, because the ratio means nothing there", () => {
  assert.equal(checkRender("Do not contact anyone at Acme.", "**Do not contact:** Acme").thin, false);
});

test("a fence wrapped around the whole answer is removed", () => {
  assert.equal(cleanRender("```markdown\n# Title\n\nBody.\n```"), "# Title\n\nBody.");
});

test("a chart fence inside the answer survives", () => {
  const answer = '# Title\n\n```chart\n{"series":[]}\n```\n\nBody.';
  assert.equal(cleanRender(answer), answer);
});

test("a wrapper is only stripped when the fences inside it balance", () => {
  // Opens with a chart and ends with a closing fence: the first line is content, not a wrapper.
  const answer = '```chart\n{"series":[]}\n```\n\n# Title\n\n```json\n{}\n```';
  assert.equal(cleanRender(answer), answer);
});

test("nothing at all is not an error", () => {
  assert.equal(cleanRender(undefined), "");
  assert.deepEqual(checkRender("", "").figures, []);
  assert.equal(checkRender("", "").coverage, 1);
});
