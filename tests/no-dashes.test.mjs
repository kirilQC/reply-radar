// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * No em dashes or en dashes in anything a person reads.
 *
 * Two halves. `stripDashes` is the last step of every AI feature (Scout, QC Bot, briefs, drafts, reports),
 * so its rewrites are pinned here. Then the app's own copy: every string literal and piece of JSX text in
 * the pages, plus the modules whose strings are shown or sent as they are, is parsed out and checked.
 * Comments are not strings, so they are not checked. A lone "—" standing in for an empty value in a table
 * cell is allowed for now; the owner decides those separately.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { stripDashes } from "../shared/no-dashes.mjs";

test("stripDashes: a spaced dash in prose becomes a comma", () => {
  assert.equal(stripDashes("Willow did well — 8 replies, 2 positive."), "Willow did well, 8 replies, 2 positive.");
  assert.equal(stripDashes("a – b"), "a, b");
  assert.equal(stripDashes("*Founders NY* — 30 replies · Amy"), "*Founders NY*, 30 replies · Amy");
});

test("stripDashes: a dash between numbers is a range", () => {
  assert.equal(stripDashes("Sep 1–5"), "Sep 1 to 5");
  assert.equal(stripDashes("10 – 20 employees"), "10 to 20 employees");
  assert.equal(stripDashes("5:00 AM – 8:00 PM"), "5:00 AM to 8:00 PM");
});

test("stripDashes: bullets, table cells and line ends", () => {
  assert.equal(stripDashes("— first\n— second"), "- first\n- second");
  assert.equal(stripDashes("| a | — | b |\n|---|---|---|"), "| a | - | b |\n|---|---|---|");
  assert.equal(stripDashes("ends with —\nnext"), "ends with\nnext");
  assert.equal(stripDashes("one more —."), "one more.");
});

test("stripDashes: anything left is a hyphen, and dash-free text is untouched", () => {
  // An unspaced em dash between words is a clause break ("context—and" reads "context, and"); an
  // unspaced en dash is a hyphen.
  assert.equal(stripDashes("word—word"), "word, word");
  assert.equal(stripDashes("pre–seed"), "pre-seed");
  assert.equal(stripDashes("—"), "-");
  const clean = "foo, bar,\nbaz | --- | x-y";
  assert.equal(stripDashes(clean), clean);
  assert.equal(stripDashes(""), "");
});

test("stripDashes: no em or en dash ever survives", () => {
  const samples = ["a—b—c", "— — —", "1–2–3", "x —\n— y —", "| — |—|", "(— aside —)", "end –"];
  for (const sample of samples) assert.doesNotMatch(stripDashes(sample), /[—–]/, sample);
});

// ---------------------------------------------------------------------------------------------------------

const ROOT = new URL("..", import.meta.url).pathname;

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

/** Every page and component, plus modules whose strings reach a person verbatim. */
const FILES = [
  ...walk(join(ROOT, "app")).filter((path) => path.endsWith(".tsx")),
  ...[
    "app/jev/[slug]/pipeline.ts",
    "app/lib/app-config.ts",
    "app/lib/client-templates.ts",
    "app/lib/deals.ts",
    "app/lib/dnc.ts",
    "app/lib/heyreach-ingestion.ts",
    "app/lib/lead-sort.ts",
    "app/lib/meetings.ts",
    "app/lib/morning-brief.ts",
    "app/lib/report-templates.ts",
    "app/lib/reply-sentiment.ts",
    "app/lib/scoring-templates.ts",
    "app/lib/tracker-setup.ts",
    "app/lib/weekly-call-brain.ts",
    "app/api/heartbeat/route.ts",
    "app/api/inbox/route.ts",
    "app/api/mcp/route.ts",
    "shared/brain-structure.mjs",
    "shared/deal-attribution.mjs",
    "shared/jev.mjs",
    "shared/onboarding.mjs",
  ].map((path) => join(ROOT, path)),
];

const STRINGISH = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

/** `"—"` on its own, or JSX text that is only a dash: an empty-value placeholder, allowed for now. */
const isPlaceholder = (node, text) =>
  /^["'`][—–]["'`]$/.test(text) || (node.kind === ts.SyntaxKind.JsxText && /^\s*[—–]\s*$/.test(text));

function dashedStrings(path) {
  const source = readFileSync(path, "utf8");
  if (!/[—–]/.test(source)) return [];
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
  const found = [];
  const visit = (node) => {
    if (STRINGISH.has(node.kind)) {
      const text = node.getText(file);
      if (/[—–]/.test(text) && !isPlaceholder(node, text)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
        found.push(`${relative(ROOT, path)}:${line}  ${text.trim().slice(0, 100)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("no user-facing string in the app contains an em or en dash", () => {
  const found = FILES.flatMap(dashedStrings);
  assert.deepEqual(found, [], `em/en dashes in user-facing strings:\n${found.join("\n")}`);
});
