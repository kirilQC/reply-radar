// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The QC Brain's shape, derived from nothing but file paths.
 *
 * There is no metadata in that repository — thirteen files out of three hundred carry frontmatter —
 * so the folder convention is the only thing the app can reason about, and every conclusion the
 * interface draws is a conclusion drawn from a string. That makes these tests unusually load-bearing:
 * a wrong answer here does not look like a bug, it looks like a client is missing an ICP they wrote
 * six months ago, and the person reading it has no way to tell the difference.
 *
 * The fixture is the real path list, warts included — the capitalised folder, the aliased engagement
 * file, the dated call notes — because those are exactly the cases that a tidier fixture would hide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BRAIN_AREAS,
  CLIENT_DOCS,
  agoLabel,
  briefSummary,
  campaignCodesIn,
  clientHue,
  clientInitials,
  clientLabel,
  clientLogoIn,
  clientOf,
  clientSkeleton,
  clientsIn,
  coverage,
  fileDate,
  fileKind,
  fileTitle,
  groupByFolder,
  isReadable,
  staleness,
} from "../shared/brain-structure.mjs";
import { campaignCode } from "../shared/campaign-code.mjs";

const PATHS = [
  "README.md",
  "clients/willow/README.md",
  "clients/willow/account/icp.md",
  "clients/willow/account/personas.md",
  "clients/willow/account/voice.md",
  "clients/willow/strategy/current-engagement.md",
  "clients/willow/feeds/crm-snapshot.md",
  "clients/willow/feeds/calls/2026-07-22-h2-plan.md",
  "clients/willow/feeds/leads/w040-export.csv",
  // The drift the aliases exist for: this client's engagement doc has the older name, and its folder
  // is already capitalised.
  "clients/Hemaptics/README.md",
  "clients/Hemaptics/strategy/engagement.md",
  "clients/bluevia-health/account/ICP.md",
  "clients/template/README.md",
  "clients/template/account/icp.md",
  "company/positioning.md",
  "wiki/sales-motion.md",
  ".claude/commands/willow-weekly.md",
];

test("a client is the folder under clients/, and the template is not one", () => {
  assert.equal(clientOf("clients/willow/account/icp.md"), "willow");
  assert.equal(clientOf("clients/template/README.md"), "", "the template is a form, not a client");
  assert.equal(clientOf("company/positioning.md"), "");
  assert.equal(clientOf("README.md"), "");
  // A folder with no file under it is not a client either — the regex needs the trailing slash.
  assert.equal(clientOf("clients/willow"), "");
});

test("client names are titled without mangling ones that already read correctly", () => {
  assert.equal(clientLabel("bluevia-health"), "Bluevia Health");
  assert.equal(clientLabel("willow"), "Willow");
  // Any capital at all means a human named it, so it is left exactly as written.
  assert.equal(clientLabel("Hemaptics"), "Hemaptics");
  assert.equal(clientLabel(""), "");
});

test("the client list is every real client, alphabetical by label", () => {
  assert.deepEqual(clientsIn(PATHS), ["bluevia-health", "Hemaptics", "willow"]);
});

test("the skeleton finds a document under its alias and under a different case", () => {
  const hemaptics = clientSkeleton("Hemaptics", PATHS);
  const engagement = hemaptics.docs.find((doc) => doc.key === "engagement");
  assert.equal(engagement.present, true, "strategy/engagement.md is the same document as current-engagement.md");
  // The *found* path is returned, not the canonical one, because that is what gets fetched and
  // written back to. Returning the canonical path would 404 on read and create a duplicate on save.
  assert.equal(engagement.found, "clients/Hemaptics/strategy/engagement.md");

  const bluevia = clientSkeleton("bluevia-health", PATHS);
  assert.equal(bluevia.docs.find((doc) => doc.key === "icp").found, "clients/bluevia-health/account/ICP.md");
});

test("a document nobody has written is reported as missing, which is the point of the skeleton", () => {
  const skeleton = clientSkeleton("bluevia-health", PATHS);
  assert.equal(skeleton.docs.find((doc) => doc.key === "personas").present, false);
  assert.equal(skeleton.docs.find((doc) => doc.key === "personas").found, "");
  assert.equal(skeleton.docs.length, CLIENT_DOCS.length, "every client shows every slot, present or not");
});

test("files outside the skeleton are kept and grouped, not dropped", () => {
  const willow = clientSkeleton("willow", PATHS);
  assert.deepEqual(willow.extras, [
    "clients/willow/feeds/calls/2026-07-22-h2-plan.md",
    "clients/willow/feeds/leads/w040-export.csv",
  ]);
  assert.deepEqual(
    willow.groups.map((group) => group.folder),
    ["feeds/calls", "feeds/leads"],
  );
  assert.equal(willow.groups[0].files[0].name, "2026-07-22-h2-plan.md");
});

test("a file claimed by the skeleton does not appear twice", () => {
  const willow = clientSkeleton("willow", PATHS);
  assert.ok(!willow.extras.includes("clients/willow/account/icp.md"));
});

test("files in the folder root group under no heading", () => {
  const groups = groupByFolder(["clients/x/notes.md", "clients/x/a/b.md"], "clients/x/");
  assert.deepEqual(groups[0], { folder: "", files: [{ path: "clients/x/notes.md", name: "notes.md" }] });
});

test("coverage counts the core documents and forgives a missing DNC list", () => {
  // Six slots minus do-not-contact. Willow has all six of the counted ones.
  const willow = coverage(clientSkeleton("willow", PATHS));
  assert.deepEqual(willow, { have: 6, total: 6, fraction: 1 });
  // Most clients have no DNC list, and counting that as a permanent gap would mean nobody ever hits
  // 100% and everybody learns to ignore the number.
  assert.equal(willow.total, CLIENT_DOCS.length - 1);
  const hemaptics = coverage(clientSkeleton("Hemaptics", PATHS));
  assert.equal(hemaptics.have, 2);
});

test("filenames become titles without their extension or their date prefix", () => {
  assert.equal(fileTitle("clients/willow/feeds/calls/2026-07-22-h2-plan.md"), "H2 plan");
  assert.equal(fileTitle("clients/willow/README.md"), "Willow overview");
  assert.equal(fileTitle("wiki/sales-motion.md"), "Sales motion");
  assert.equal(fileDate("clients/willow/feeds/calls/2026-07-22-h2-plan.md"), "2026-07-22");
  assert.equal(fileDate("wiki/sales-motion.md"), "");
});

test("only markdown is rendered in the app, everything else is linked", () => {
  assert.equal(fileKind("a/b.md"), "doc");
  assert.equal(fileKind("a/b.csv"), "table");
  assert.equal(fileKind("a/b.PNG"), "image");
  assert.equal(fileKind("a/b.jsonl"), "data");
  assert.equal(fileKind("a/b.sh"), "script");
  assert.equal(fileKind("a/Makefile"), "other");
  assert.equal(isReadable("a/b.md"), true);
  // Four thousand lines of JSON pasted into a reading surface is worse than a link to GitHub.
  assert.equal(isReadable("a/b.jsonl"), false);
});

test("campaign codes are found without inventing ones that are not there", () => {
  assert.deepEqual(
    campaignCodesIn("We are running CT003 and W040 against the same list; SW019 is paused."),
    ["CT003", "SW019", "W040"],
  );
  // The spellings the live accounts actually use, normalised to the one form both sides of the join
  // compare on. `CT50` and `CT050` are two different campaigns, so the digits are never padded.
  assert.deepEqual(campaignCodesIn("CT:010 and Ct007 and CT50"), ["CT007", "CT010", "CT50"]);
  // The join is only worth anything if a code links to a campaign that exists. A loose pattern turns
  // dates, version numbers and ordinary capitals into dead links throughout the prose.
  assert.deepEqual(campaignCodesIn("Q4 2026 revenue was up, per RFC1234 and ISO 8601."), []);
  assert.deepEqual(campaignCodesIn("The H2 plan is B2B, and we are SOC2 by Q1."), []);
  assert.deepEqual(campaignCodesIn("lowercase ct003 is not a code"), []);
  assert.deepEqual(campaignCodesIn(""), []);
  assert.deepEqual(campaignCodesIn("CT003 again and CT003 twice"), ["CT003"], "each code once");
});

test("a code in the prose and a code in a HeyReach name normalise to the same string", () => {
  // This is the join. If these two disagree the campaign link silently never fires, which looks like
  // the feature was never built rather than like a bug.
  for (const [prose, live] of [
    ["CT003", "CT003: RSA (All Personas)"],
    ["CT010", "CT:010 BSidesSD Speakers"],
    ["CT049", "CT049_R3_Connect_Logan"],
    ["W040", "  W040: Website ICP Visitors"],
    ["CT50", "CT50: D&R HH"],
    ["CT007", "Ct007: Second attempt"],
  ]) {
    assert.deepEqual(campaignCodesIn(prose), [campaignCode(live)], `${prose} did not join to ${live}`);
  }
});

test("staleness is in days, and missing is not the same as old", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  assert.deepEqual(staleness("2026-08-13T00:00:00Z", now), { days: 0, stale: false });
  assert.deepEqual(staleness("2026-01-01T00:00:00Z", now), { days: 224, stale: true });
  // A document that has never existed has no age. The interface says "missing", which asks for a
  // different action than "old".
  assert.deepEqual(staleness("", now), { days: null, stale: false });
  assert.deepEqual(staleness("not a date", now), { days: null, stale: false });
});

test("ages read the way a person would say them", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  assert.equal(agoLabel("2026-08-13T00:00:00Z", now), "today");
  assert.equal(agoLabel("2026-08-12T00:00:00Z", now), "yesterday");
  assert.equal(agoLabel("2026-08-01T00:00:00Z", now), "12 days ago");
  assert.equal(agoLabel("2026-07-01T00:00:00Z", now), "1 month ago");
  assert.equal(agoLabel("2026-02-13T00:00:00Z", now), "6 months ago");
  assert.equal(agoLabel("2024-08-13T00:00:00Z", now), "2 years ago");
  assert.equal(agoLabel("", now), "");
});

test("the non-client areas cover the folders the repo actually has", () => {
  const prefixes = BRAIN_AREAS.map((area) => area.prefix);
  for (const path of ["company/positioning.md", "wiki/sales-motion.md", ".claude/commands/willow-weekly.md"]) {
    assert.ok(prefixes.some((prefix) => path.startsWith(prefix)), `${path} belongs to no area`);
  }
});

/**
 * The client mark. Most clients have no logo committed, so the fallback is what people will
 * actually see — and a fallback that changed colour between renders would be worse than no colour
 * at all, because the whole job of a monogram tile is to be recognisable without being read.
 */
test("initials come from the words a person would shorten", () => {
  assert.equal(clientInitials("Willow"), "WI");
  assert.equal(clientInitials("Cardinal Trust"), "CT");
  assert.equal(clientInitials("steady-well"), "SW");
  assert.equal(clientInitials("open_ocean labs"), "OO");
  assert.equal(clientInitials(""), "?");
  assert.equal(clientInitials(undefined), "?");
});

test("a client's colour is the same every time it is asked for", () => {
  assert.equal(clientHue("willow"), clientHue("willow"));
  assert.notEqual(clientHue("willow"), clientHue("webrix"));
  for (const name of ["willow", "webrix", "cardinal-trust", ""]) {
    const hue = clientHue(name);
    assert.ok(Number.isInteger(hue) && hue >= 0 && hue < 360, `${name} gave ${hue}`);
  }
});

test("a logo is found only inside the client's own folder", () => {
  const paths = [
    "clients/willow/logo.png",
    "clients/willow/icp.md",
    "clients/webrix/assets/screenshot.png",
    "clients/steadywell/LOGO.SVG",
    "company/logo.png",
  ];
  assert.equal(clientLogoIn(paths, "willow"), "clients/willow/logo.png");
  // Case is a person's typing, not a meaningful difference.
  assert.equal(clientLogoIn(paths, "steadywell"), "clients/steadywell/LOGO.SVG");
  // A screenshot buried in an assets folder is not a logo, and neither is the company's own.
  assert.equal(clientLogoIn(paths, "webrix"), "");
  assert.equal(clientLogoIn(paths, "nobody"), "");
  assert.equal(clientLogoIn([], "willow"), "");
});

/**
 * The summary is the first thing anyone sees on a client's page, and it is lifted from a document
 * nobody wrote with that in mind. Every one of these is a real shape a README takes: a title above
 * the prose, a hard-wrapped paragraph, a table of details, a badge line, a bullet list of facts.
 * Getting one wrong does not error — it puts `| Field | Value |` at the top of a client's page.
 */
test("the summary is the first real paragraph, not the title above it", () => {
  const { summary } = briefSummary("# Willow\n\nWillow sells payroll software to mid-market\nconstruction firms in the UK.\n\n## ICP\n\nSomething else entirely.\n");
  assert.equal(summary, "Willow sells payroll software to mid-market construction firms in the UK.");
});

test("frontmatter, badges, tables and lists never become the summary", () => {
  const brief = [
    "---",
    "client: willow",
    "---",
    "",
    "# Willow",
    "",
    '<img src="logo.png" />',
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Seats | 40 |",
    "",
    "> A quote from the founder.",
    "",
    "- Founded 2019",
    "",
    "Willow is a payroll platform.",
  ].join("\n");
  assert.equal(briefSummary(brief).summary, "Willow is a payroll platform.");
});

test("labelled details are lifted out as facts rather than left in the prose", () => {
  const { summary, facts } = briefSummary("# Webrix\n\n- **Website:** webrix.io\n- **Industry:** Construction tech\n\nWebrix builds site-management software.\n");
  assert.equal(summary, "Webrix builds site-management software.");
  assert.deepEqual(facts, [
    { label: "Website", value: "webrix.io" },
    { label: "Industry", value: "Construction tech" },
  ]);
});

test("markdown links and emphasis are read as the words they wrap", () => {
  const { summary } = briefSummary("Willow (**[willow.com](https://willow.com)**) sells to _builders_.");
  assert.equal(summary, "Willow (willow.com) sells to builders.");
});

test("a long summary is cut at a sentence, and a long sentence is cut with an ellipsis", () => {
  const sentences = "Willow sells payroll software. It serves construction firms. It was founded in 2019. It has forty staff.";
  const cut = briefSummary(sentences, 60).summary;
  assert.ok(cut.endsWith("."), cut);
  assert.ok(cut.length <= 60, cut);
  assert.ok(!cut.includes("forty staff"), cut);

  const oneSentence = briefSummary(`Willow ${"very ".repeat(40)}long`, 60).summary;
  assert.ok(oneSentence.endsWith("…"), oneSentence);
  assert.ok(oneSentence.length <= 61, oneSentence);
});

test("a brief that is only headings gives an empty summary rather than a heading", () => {
  assert.deepEqual(briefSummary("# Willow\n\n## ICP\n\n### Personas\n"), { summary: "", facts: [] });
  assert.deepEqual(briefSummary(""), { summary: "", facts: [] });
  assert.deepEqual(briefSummary(undefined), { summary: "", facts: [] });
});
