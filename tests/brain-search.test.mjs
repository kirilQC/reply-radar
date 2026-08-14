// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Search is how anyone who does not know the folder layout gets into the brain.
 *
 * Which is everyone this front end is for. The repo is three hundred untagged markdown files, so if
 * search ranks badly it is not a mildly worse experience — it is the difference between the tab being
 * how people find things and the tab being something they tried once and went back to GitHub.
 *
 * The case that matters most is the one below: "willow icp" has to return Willow's ICP first, not the
 * forty call notes that happen to say the word Willow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { headings, scoreDoc, searchBrain, snippet, terms } from "../shared/brain-search.mjs";
import { parseSkill, skillClient } from "../shared/brain-structure.mjs";

const DOCS = [
  {
    path: "clients/willow/account/icp.md",
    title: "Icp",
    text: "# Willow ICP\n\nMid-market construction firms in the UK with 50-500 staff and an in-house H&S lead.\n",
  },
  {
    path: "clients/willow/feeds/calls/2026-07-22-h2-plan.md",
    title: "H2 plan",
    text: "# H2 plan\n\nWe talked about Willow's ICP and whether the ICP still holds. Willow wants more volume.\nWillow asked about W040.\n",
  },
  {
    path: "clients/cotool/account/icp.md",
    title: "Icp",
    text: "# Cotool ICP\n\nSecurity engineering leaders at series B and later software companies.\n",
  },
];

test("a query is its words, and quoted phrases survive whole", () => {
  assert.deepEqual(terms("willow icp"), ["willow", "icp"]);
  assert.deepEqual(terms('  "reply rate" willow  '), ["reply rate", "willow"]);
  // A single character matches everything and orders nothing.
  assert.deepEqual(terms("a willow"), ["willow"]);
  assert.deepEqual(terms(""), []);
});

test("the filename beats the body, which is the whole point of the ranking", () => {
  const results = searchBrain(DOCS, "willow icp");
  // The call note mentions both words five times over. The document actually named for them wins
  // anyway, because a person typing "willow icp" wants one file and not a reading list.
  assert.equal(results[0].path, "clients/willow/account/icp.md");
  assert.equal(results.length, 2, "Cotool's ICP does not mention Willow, so it is not a result");
});

test("every term has to appear — more words means fewer results, not more", () => {
  assert.equal(searchBrain(DOCS, "willow").length, 2);
  assert.equal(searchBrain(DOCS, "willow construction").length, 1);
  assert.equal(searchBrain(DOCS, "willow nonexistentword").length, 0);
});

test("a document missing a term scores nothing rather than nearly matching", () => {
  assert.equal(scoreDoc(DOCS[2], ["willow"]), null);
  assert.ok(scoreDoc(DOCS[0], ["willow"]) > 0);
});

test("repetition counts, but only up to a point", () => {
  const once = scoreDoc({ path: "a.md", title: "", text: "willow" }, ["willow"]);
  const many = scoreDoc({ path: "a.md", title: "", text: "willow ".repeat(400) }, ["willow"]);
  assert.ok(many > once);
  // Otherwise the longest file in the repo wins every search it appears in.
  assert.ok(many - once <= 8);
});

test("headings are read, because they are the closest thing these files have to a summary", () => {
  assert.deepEqual(headings("# One\ntext\n## Two\n#### Four is too deep\n"), ["One", "Two"]);
});

test("the snippet is the line that answered the query, without the markdown", () => {
  assert.equal(
    snippet(DOCS[0].text, ["willow", "icp"]),
    "Mid-market construction firms in the UK with 50-500 staff and an in-house H&S lead.",
    "the heading is too short to be a snippet, so the sentence under it is used",
  );
  // A table row is the answer often enough that it has to survive being stripped of its pipes.
  assert.equal(snippet("| **Reply rate** | 63.2% |", ["rate"]), "Reply rate · 63.2%");
  // The separator row underneath it is punctuation pretending to be content.
  assert.equal(snippet("|---|---|\n| Reply rate | 63.2% |", ["rate"]), "Reply rate · 63.2%");
  assert.equal(snippet("", ["x"]), "");
});

test("identical queries come back in identical order", () => {
  const first = searchBrain(DOCS, "icp").map((hit) => hit.path);
  const second = searchBrain(DOCS, "icp").map((hit) => hit.path);
  assert.deepEqual(first, second);
  // The two files named `icp.md` score identically, and they are ordered by path rather than by
  // whatever order they were fetched in — which for a concurrent fetch is not the same twice. The
  // call note merely mentions the word, so it comes last.
  assert.deepEqual(first, [
    "clients/cotool/account/icp.md",
    "clients/willow/account/icp.md",
    "clients/willow/feeds/calls/2026-07-22-h2-plan.md",
  ]);
});

test("a command's description comes from its frontmatter, or from its first sentence", () => {
  const front = parseSkill(".claude/commands/willow-weekly.md", "---\ndescription: Build Willow's weekly report\n---\n\n# Weekly\n\nDo the thing.\n");
  assert.equal(front.command, "/willow-weekly");
  assert.equal(front.blurb, "Build Willow's weekly report");

  // Most of them have no frontmatter at all, and a catalogue of bare filenames would be no more
  // useful than the folder listing it replaces.
  const bare = parseSkill(".claude/commands/audit.md", "# Audit\n\n```\ncode block\n```\n\nChecks every campaign for a missing follow-up.\n");
  assert.equal(bare.blurb, "Checks every campaign for a missing follow-up.");
});

test("a command named for a client belongs to that client", () => {
  const clients = ["willow", "cotool", "review"];
  assert.equal(skillClient("willow-weekly", clients), "willow");
  assert.equal(skillClient("cotool", clients), "cotool");
  // Matching anywhere in the name rather than at the front would file the general weekly review
  // under a client called "review".
  assert.equal(skillClient("weekly-review", clients), "");
  assert.equal(skillClient("audit", clients), "");
});
