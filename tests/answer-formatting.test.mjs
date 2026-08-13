/**
 * The answer on screen has to match the answer the model wrote.
 *
 * These two modules sit between Claude and the reader, and every bug in them is a bug that makes the
 * assistant look wrong when it was right — a table printed as pipes, a rate landing in the wrong
 * column, a comma in a company name shifting a spreadsheet by one. So the fixture below is the real
 * reply from the first question anyone asked this thing, pipes and asterisks and warning signs
 * included, rather than markdown invented to suit the parser.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, parseInline, spansToText } from "../shared/markdown-blocks.mjs";
import { answerToCsv, csvField, exportFilename } from "../shared/answer-export.mjs";

/** Verbatim from the MCP tab, answering "Which of Cotool's campaigns has the best reply rate?". */
const ANSWER = `Filtering out campaigns with very small sample sizes (fewer than 10 conversations started, where rates are statistically noisy), here are the top performers by reply rate:

| Campaign | Conversations Started | Reply Rate |
|---|---|---|
| CT001: RSA (Detection & Response) | 4 | 75% ⚠️ tiny sample |
| CT001: RSA (SecEng) | 7 | 71.4% ⚠️ tiny sample |
| **CT50: D&R HH** | **19** | **63.2%** |
| CT001: RSA (All Personas) | 108 | 53.7% |
| CT005: RSA - 1st Degree Max | 80 | 43.8% |

**Best reply rate with a meaningful sample size: CT50: D&R HH at 63.2%** (19 conversations, 12 replies). The CT001 Detection & Response and SecEng splits beat it on paper, but with only 4 and 7 conversations respectively, those numbers aren't reliable.`;

test("the table from a real answer parses as a table", () => {
  const table = parseBlocks(ANSWER).find((block) => block.kind === "table");
  assert.ok(table, "the pipes did not become a table, which is the whole bug this fixes");
  assert.deepEqual(table.head.map(spansToText), ["Campaign", "Conversations Started", "Reply Rate"]);
  assert.equal(table.rows.length, 5);
  assert.deepEqual(table.rows[2].map(spansToText), ["CT50: D&R HH", "19", "63.2%"]);
});

test("bold inside a table cell is bold, not asterisks", () => {
  const table = parseBlocks(ANSWER).find((block) => block.kind === "table");
  // `**CT50: D&R HH**` was printed with the asterisks showing. The text has to survive stripped of
  // them, or the export writes them into a spreadsheet cell.
  assert.deepEqual(table.rows[2][0], [{ kind: "bold", text: "CT50: D&R HH" }]);
});

test("the prose around the table survives as paragraphs", () => {
  const blocks = parseBlocks(ANSWER);
  assert.equal(blocks[0].kind, "paragraph");
  assert.match(spansToText(blocks[0].spans), /^Filtering out campaigns/);
  assert.equal(blocks.at(-1).kind, "paragraph");
  assert.match(spansToText(blocks.at(-1).spans), /aren't reliable\.$/);
});

test("a pipe in a sentence is not a table", () => {
  // Without the separator-line check, any prose containing a pipe became a one-column table.
  const blocks = parseBlocks("Revenue | pipeline is the phrase people use.");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
});

test("headings, rules, bullets and numbered lists are each themselves", () => {
  const blocks = parseBlocks(`## Steadywell\n\n- one\n- two\n\n---\n\n1. first\n2. second`);
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["heading", "list", "rule", "list"],
  );
  assert.equal(blocks[0].level, 2);
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(blocks[3].items.map((item) => spansToText(item.spans)), ["first", "second"]);
});

test("an indented bullet keeps its depth", () => {
  const [list] = parseBlocks("- top\n  - nested");
  assert.deepEqual(list.items.map((item) => item.depth), [0, 1]);
});

test("a paragraph between two lists keeps them apart", () => {
  const blocks = parseBlocks("- one\n\nthen this\n\n- two");
  assert.deepEqual(blocks.map((block) => block.kind), ["list", "paragraph", "list"]);
});

test("inline code, links and italics come through", () => {
  assert.deepEqual(parseInline("a `code` b"), [
    { kind: "text", text: "a " },
    { kind: "code", text: "code" },
    { kind: "text", text: " b" },
  ]);
  assert.deepEqual(parseInline("[Kiril](https://example.com)"), [
    { kind: "link", text: "Kiril", href: "https://example.com" },
  ]);
  assert.deepEqual(parseInline("_quietly_"), [{ kind: "italic", text: "quietly" }]);
});

test("bold wins over italic on the same run", () => {
  // `**x**` matched as two italics would render as `*x*` with stray asterisks.
  assert.deepEqual(parseInline("**x**"), [{ kind: "bold", text: "x" }]);
});

test("a fenced block is taken verbatim and an unclosed fence does not eat the answer", () => {
  const [block] = parseBlocks("```sql\nselect 1\n```");
  assert.equal(block.kind, "code");
  assert.equal(block.text, "select 1");
  // A reply cut off mid-fence is common when the model runs out of tokens.
  const [truncated] = parseBlocks("```\nselect 1");
  assert.equal(truncated.kind, "code");
  assert.equal(truncated.text, "select 1");
});

test("unrecognised markdown degrades to plain text rather than to nothing", () => {
  const blocks = parseBlocks("> a blockquote we do not handle");
  assert.equal(blocks.length, 1);
  assert.equal(spansToText(blocks[0].spans), "> a blockquote we do not handle");
});

test("empty input yields nothing rather than throwing", () => {
  assert.deepEqual(parseBlocks(""), []);
  assert.deepEqual(parseBlocks(null), []);
  assert.deepEqual(parseInline(undefined), []);
});

test("the CSV of a real answer has the table's rows in it", () => {
  const csv = answerToCsv({ question: "Which of Cotool's campaigns has the best reply rate?", answer: ANSWER, askedAt: "2026-08-13T10:04:00.000Z" });
  const lines = csv.split("\n");
  assert.match(lines[0], /^Question,/);
  assert.ok(lines.includes("Campaign,Conversations Started,Reply Rate"));
  assert.ok(lines.includes("CT50: D&R HH,19,63.2%"), "the bold row lost its text on the way to the sheet");
  assert.equal(lines.filter((line) => line.startsWith("CT")).length, 5, "every campaign row should reach the sheet");
});

test("a comma inside a cell is quoted so the columns cannot shift", () => {
  assert.equal(csvField("Bell, Book and Candle"), '"Bell, Book and Candle"');
  assert.equal(csvField('He said "no"'), '"He said ""no"""');
  assert.equal(csvField("CT001"), "CT001");
  assert.equal(csvField(null), "");
  // Leading space is quoted too: a spreadsheet strips it otherwise and " 12" stops matching "12".
  assert.equal(csvField(" 12"), '" 12"');
});

test("an answer with no table exports its prose instead of an empty file", () => {
  const csv = answerToCsv({ question: "Is Steadywell healthy?", answer: "Yes.\n\n- Sessions are valid\n- Leads are running low" });
  const lines = csv.split("\n");
  assert.ok(lines.includes("Answer"));
  assert.ok(lines.includes("Yes."));
  assert.ok(lines.includes("Sessions are valid"));
});

test("two tables stack rather than merge", () => {
  const answer = "| a |\n|---|\n| 1 |\n\n| b | c |\n|---|---|\n| 2 | 3 |";
  const lines = answerToCsv({ answer }).split("\n");
  assert.ok(lines.includes("a"));
  assert.ok(lines.includes("b,c"));
  assert.ok(lines.includes("2,3"));
});

test("the filename says what the file is", () => {
  assert.equal(
    exportFilename("Which of Cotool's campaigns has the best reply rate?", "2026-08-13T10:04:00.000Z", "csv"),
    "reply-radar-which-of-cotools-campaigns-has-the-2026-08-13.csv",
  );
  assert.match(exportFilename("", "", "pdf"), /^reply-radar-answer-\d{4}-\d{2}-\d{2}\.pdf$/);
});
