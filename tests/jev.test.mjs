// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import {
  duplicateIndexes,
  identify,
  isAiArkExport,
  normalizeQuestionSet,
  parseCsv,
  parseGeneratedQuestionSet,
  passProbability,
  profileFor,
  toCsv,
  toWireQuestions,
  verdictFor,
} from "../shared/jev.mjs";

test("parseCsv handles quotes, embedded commas and newlines, CRLF, a BOM and blank lines", () => {
  const text = '\uFEFFName,About,Title\r\n"Lee, Ada","Builds things,\nships them","CEO"\r\n\r\nBo,"She said ""hi""",CTO\n';
  const { headers, rows } = parseCsv(text);
  assert.deepEqual(headers, ["Name", "About", "Title"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Name, "Lee, Ada");
  assert.equal(rows[0].About, "Builds things,\nships them");
  assert.equal(rows[1].About, 'She said "hi"');
});

test("parseCsv edge cases: trailing comma, empty trailing field, lone CR, unterminated quote, empty input", () => {
  assert.deepEqual(parseCsv("a,b,c\n1,2,\n").rows, [{ a: "1", b: "2", c: "" }]);
  assert.deepEqual(parseCsv("a,b\r1,2\r").rows, [{ a: "1", b: "2" }]);
  assert.deepEqual(parseCsv('a,b\n"x,y').rows, [{ a: "x,y", b: "" }]);
  assert.deepEqual(parseCsv('a,b\n"",x').rows, [{ a: "", b: "x" }]);
  assert.deepEqual(parseCsv("a,b\n1,2").rows, [{ a: "1", b: "2" }]);
  assert.deepEqual(parseCsv(""), { headers: [], rows: [] });
  assert.deepEqual(parseCsv("a,b\n1,2", { asArrays: true }).rows, [["1", "2"]]);
});

test("parseCsv makes duplicate headers unique rather than overwriting", () => {
  const { headers, rows } = parseCsv("Email,Email\na@x.com,b@x.com");
  assert.deepEqual(headers, ["Email", "Email (2)"]);
  assert.equal(rows[0]["Email (2)"], "b@x.com");
});

test("toCsv round-trips through parseCsv", () => {
  const rows = [{ a: 'x, "y"', b: "line\nbreak" }, { a: "plain", b: "" }];
  const { rows: back } = parseCsv(toCsv(["a", "b"], rows));
  assert.deepEqual(back, rows);
});

const AIARK_HEADERS = ["First Name", "Last Name", "Full Name", "Title", "Organization", "Headline", "Summary", "Seniority", "Department", "LinkedIn", "Email Business", "Location",
  "1st Experience Title", "1st Experience Company", "1st Experience is Current", "1st Experience Start Date", "1st Experience Summary",
  "2nd Experience Title", "2nd Experience Company", "2nd Experience is Current", "2nd Experience Start Date", "2nd Experience Summary",
  "3rd Experience Title", "3rd Experience Company", "3rd Experience is Current",
  "Company Name", "Company Industry", "Company Employee Count", "Company Description", "Company Product and Services", "Company Last Funding Type", "Company Country", "Profile Picture URL"];

const sideRoleRow = {
  "First Name": "Jeffrey", "Last Name": "L", "Full Name": "Jeffrey L", Title: "Co-founder / Sr Board Advisor", Organization: "Lumenuity, Inc.",
  Headline: "CEO | Launch i/o, Inc", Summary: "Now Founder and CEO of Launch i/o, a boutique supply chain consultancy.", Seniority: "founder", Department: "business_development",
  LinkedIn: "https://www.linkedin.com/in/jeffrey-l", "Email Business": "j@x.com", Location: "Chicago",
  "1st Experience Title": "Founder & CEO", "1st Experience Company": "Launch i/o, INC", "1st Experience is Current": "true", "1st Experience Start Date": "2018-11-01", "1st Experience Summary": "Boutique consulting.",
  "2nd Experience Title": "Co-founder / Sr Board Advisor", "2nd Experience Company": "Lumenuity, Inc.", "2nd Experience is Current": "true", "2nd Experience Start Date": "2019-07-01", "2nd Experience Summary": "",
  "3rd Experience Title": "VP Operations", "3rd Experience Company": "Lenovo", "3rd Experience is Current": "false",
  "Company Name": "Lumenuity, Inc.", "Company Industry": "software development", "Company Employee Count": "2-10", "Company Description": "Deep-tech optics company.", "Company Product and Services": "", "Company Last Funding Type": "SEED_ROUND", "Company Country": "United States",
  "Profile Picture URL": "https://media.licdn.com/x.jpg",
};

test("an AI Ark export is recognised and trimmed to what decides fit", () => {
  assert.equal(isAiArkExport(AIARK_HEADERS), true);
  assert.equal(isAiArkExport(["Name", "Title", "Company"]), false);
  const profile = profileFor(sideRoleRow, AIARK_HEADERS);
  assert.equal(profile.listed_company, "Lumenuity, Inc.");
  assert.equal(profile.headline, "CEO | Launch i/o, Inc");
  // Every current role is kept — the side role and the real job — and past roles are not.
  assert.deepEqual(profile.current_roles.map((r) => r.company), ["Launch i/o, INC", "Lumenuity, Inc."]);
  assert.equal(JSON.stringify(profile).includes("Lenovo"), false);
  // Identity, contact details and photos never reach Jev.
  const flat = JSON.stringify(profile);
  for (const leaked of ["Jeffrey", "j@x.com", "linkedin.com", "licdn"]) assert.equal(flat.includes(leaked), false, leaked);
  // Empty fields are pruned rather than sent as "".
  assert.equal("products" in profile.listed_company_profile, false);
  assert.equal(flat.includes('""'), false);
});

test("a generic export keeps useful columns and drops noise", () => {
  const headers = ["Full Name", "Job Title", "Company", "Industry", "Person Linkedin Url", "Email", "Phone", "Notes"];
  const row = { "Full Name": "Ada Lee", "Job Title": "CISO", Company: "Acme", Industry: "Fintech", "Person Linkedin Url": "linkedin.com/in/ada", Email: "a@acme.com", Phone: "555", Notes: "" };
  const profile = profileFor(row, headers);
  assert.deepEqual(Object.keys(profile), ["Job Title", "Company", "Industry"]);
  assert.deepEqual(identify(row, headers), { name: "Ada Lee", title: "CISO", company: "Acme", linkedin: "linkedin.com/in/ada" });
});

test("duplicates are found by normalised LinkedIn URL, then by name and company", () => {
  const people = [
    { name: "A", company: "X", linkedin: "https://www.linkedin.com/in/ada/" },
    { name: "A2", company: "Y", linkedin: "http://linkedin.com/in/ada?trk=1" },
    { name: "Bo", company: "Z", linkedin: "" },
    { name: "bo", company: "z", linkedin: "" },
    { name: "Cy", company: "Z", linkedin: "" },
  ];
  assert.deepEqual([...duplicateIndexes(people)].sort(), [1, 3]);
});

test("normalizeQuestionSet keeps usable questions and reports the rest", () => {
  const { questions, problems, thresholds } = normalizeQuestionSet({
    questions: [
      { label: "Main job", type: "noul", instructions: "Is `listed_company` their main job?", criteria: { true: "Yes", false: "Side role" } },
      { label: "Competitor", type: "boolean", instructions: "Is the company a competitor?", pass: false },
      { label: "Seniority", type: "choice", instructions: "How senior?", criteria: { "Exec": "C-level", junior: "IC", unclear: null }, pass: ["exec"] },
      { label: "Empty", type: "noul", instructions: "" },
      { label: "One option", type: "choice", instructions: "?", criteria: { a: "x" }, pass: ["a"] },
      { label: "All pass", type: "choice", instructions: "?", criteria: { a: "x", b: "y" }, pass: ["a", "b"] },
    ],
    thresholds: { keep: 0.3, drop: 0.5 },
  });
  assert.deepEqual(questions.map((q) => q.key), ["main_job", "competitor", "seniority"]);
  assert.equal(questions[1].type, "noul");
  assert.equal(questions[1].pass, false);
  assert.deepEqual(questions[2].pass, ["exec"]);
  assert.equal(problems.length, 4);
  assert.deepEqual(thresholds, { keep: 0.6, drop: 0.35 });
});

test("toWireQuestions strips our own fields and sends TypeSafe's shape", () => {
  const { questions } = normalizeQuestionSet({ questions: [
    { label: "Main job", type: "noul", instructions: "Q?", criteria: { true: "t" } },
    { label: "Tier", type: "choice", instructions: "Which?", criteria: { a: "x", b: "y" }, pass: ["a"] },
  ] });
  assert.deepEqual(toWireQuestions(questions), {
    main_job: { type: "noul", instructions: "Q?", criteria: { true: "t" } },
    tier: { type: "choice", instructions: "Which?", criteria: { a: "x", b: "y" } },
  });
});

test("passProbability inverts a no-is-fit noul and sums fitting choice options", () => {
  assert.equal(passProbability({ type: "noul", pass: true }, { type: "noul", noul: 0.9 }), 0.9);
  assert.ok(Math.abs(passProbability({ type: "noul", pass: false }, { type: "noul", noul: 0.9 }) - 0.1) < 1e-9);
  assert.ok(Math.abs(passProbability({ type: "choice", pass: ["a", "b"] }, { type: "choice", choice: "c", probabilities: { a: 0.3, b: 0.25, c: 0.45 } }) - 0.55) < 1e-9);
  assert.equal(passProbability({ type: "noul", pass: true }, undefined), null);
});

test("verdictFor: every question must pass to keep, one clear fail drops, the rest is borderline", () => {
  const { questions } = normalizeQuestionSet({ questions: [
    { label: "Main job", type: "noul", instructions: "?" },
    { label: "Competitor", type: "noul", instructions: "?", pass: false },
  ] });
  const t = { keep: 0.6, drop: 0.35 };
  assert.equal(verdictFor(questions, { main_job: { noul: 0.95 }, competitor: { noul: 0.05 } }, t).verdict, "good");
  const bad = verdictFor(questions, { main_job: { noul: 0.95 }, competitor: { noul: 0.9 } }, t);
  assert.equal(bad.verdict, "bad");
  assert.equal(bad.reason, "Failed: Competitor");
  const unsure = verdictFor(questions, { main_job: { noul: 0.5 }, competitor: { noul: 0.05 } }, t);
  assert.equal(unsure.verdict, "borderline");
  assert.equal(unsure.reason, "Unsure: Main job");
  // A question left unanswered never silently passes a contact.
  assert.equal(verdictFor(questions, { main_job: { noul: 0.95 } }, t).verdict, "borderline");
  // …but a clear fail elsewhere still drops them.
  assert.equal(verdictFor(questions, { competitor: { noul: 0.99 } }, t).verdict, "bad");
});

test("parseGeneratedQuestionSet reads fenced or chatty JSON and rejects nonsense", () => {
  const fenced = '```json\n{"questions":[{"label":"Main job","type":"noul","instructions":"Is it?"}]}\n```';
  assert.equal(parseGeneratedQuestionSet(fenced).questions.length, 1);
  assert.equal(parseGeneratedQuestionSet('Here you go: {"questions":[{"label":"X","type":"noul","instructions":"?"}]} Hope that helps').questions.length, 1);
  assert.equal(parseGeneratedQuestionSet("no json here").questions.length, 0);
});
