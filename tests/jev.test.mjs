// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProfile,
  duplicateIndexes,
  duplicateOf,
  identify,
  identifyWith,
  buildCompanyProfile,
  identifyCompany,
  mergeNamedTags,
  missingFields,
  normalizeTagSet,
  parseGeneratedTagSet,
  parseTagEntries,
  parseTagList,
  planColumns,
  tagVerdict,
  toTagWire,
  addTags,
  applyKeepTerm,
  compactAnswers,
  findKeepTerm,
  contactReviewItem,
  parseContactReview,
  mergeProposals,
  parseReview,
  reviewItem,
  normalizeIcp,
  normalizeQuestionSet,
  otherSample,
  parseCsv,
  parseSuggestions,
  parseEmployees,
  sizeCheck,
  titlePoolQuestion,
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

test("an AI Ark-style export is read into the fixed profile shape", () => {
  const profile = profileFor(sideRoleRow, AIARK_HEADERS);
  assert.equal(profile.listed_company, "Lumenuity, Inc.");
  assert.equal(profile.headline, "CEO | Launch i/o, Inc");
  // Every current role is kept — the side role and the real job.
  assert.deepEqual(profile.current_roles.map((r) => r.company), ["Launch i/o, INC", "Lumenuity, Inc."]);
  // The ended Lenovo job is history, not a current role.
  assert.equal(JSON.stringify(profile.current_roles).includes("Lenovo"), false);
  assert.deepEqual(profile.past_roles, [{ title: "VP Operations", company: "Lenovo" }]);
  assert.equal(profile.listed_company_profile.description, "Deep-tech optics company.");
  // Identity, contact details and photos never reach Jev.
  const flat = JSON.stringify(profile);
  for (const leaked of ["Jeffrey", "j@x.com", "linkedin.com", "licdn"]) assert.equal(flat.includes(leaked), false, leaked);
  // Empty fields are pruned rather than sent as "".
  assert.equal("products" in profile.listed_company_profile, false);
  assert.equal(flat.includes('""'), false);
  assert.equal(identify(sideRoleRow, AIARK_HEADERS).linkedin, "https://www.linkedin.com/in/jeffrey-l");
});

const csvRows = (text) => parseCsv(text, { asArrays: true });
const roleOf = (plan, header) => plan.columns.find((c) => c.header === header)?.role;

test("Apollo-style headers map onto the same profile fields", () => {
  const { headers, rows } = csvRows(`First Name,Last Name,Title,Company,Company Name for Emails,Email,Seniority,Departments,# Employees,Industry,Keywords,Person Linkedin Url,Website,City,State,Country,Total Funding,Latest Funding,Short Description,Apollo Contact Id
Maya,Chen,VP of Security,Northwind Bank,Northwind,maya@nw.com,vp,Information Technology,5200,banking,"fraud, payments",http://www.linkedin.com/in/mayachen,http://nw.com,New York,New York,United States,50000000,Series C,Regional bank for mid-market businesses,5f1`);
  const plan = planColumns(headers, rows);
  assert.equal(roleOf(plan, "Company Name for Emails"), "ignore");
  assert.equal(roleOf(plan, "Total Funding"), "ignore");
  assert.equal(roleOf(plan, "Latest Funding"), "company_funding");
  const p = buildProfile(rows[0], plan);
  assert.deepEqual(p, {
    listed_title: "VP of Security", listed_company: "Northwind Bank", seniority: "vp", department: "Information Technology",
    location: "New York, United States",
    listed_company_profile: { industry: "banking", employees: "5200", description: "Regional bank for mid-market businesses", products: "fraud, payments", funding: "Series C" },
  });
  assert.equal(identifyWith(rows[0], plan).linkedin, "http://www.linkedin.com/in/mayachen");
});

test("Sales Nav-style headers: company scope, LinkedIn casing, unrecognised text kept as extra", () => {
  const { headers, rows } = csvRows(`Full Name,Job Title,Company,Company Domain,Profile URL,Location,Industry,Headcount,Tenure in Position,Headline,Summary
Ada Lee,CISO,Acme Health,acme.com,https://www.linkedin.com/sales/lead/A,"Boston, MA",Hospitals and Health Care,201-500,1 year 2 months,CISO at Acme,Security leader`);
  const plan = planColumns(headers, rows);
  assert.equal(roleOf(plan, "Company Domain"), "website"); // identifies the company; never sent
  assert.equal(roleOf(plan, "Profile URL"), "linkedin");
  const p = buildProfile(rows[0], plan);
  assert.equal(p.listed_company_profile.industry, "Hospitals and Health Care");
  assert.deepEqual(p.other, { "Tenure in Position": "1 year 2 months" });
  assert.equal("Full Name" in p, false);
});

test("job history is read from numbered columns with end dates, and from a JSON list", () => {
  const numbered = csvRows(`First,Last,Experience 1 Title,Experience 1 Company,Experience 1 End Date,Experience 2 Title,Experience 2 Company,Experience 2 End Date
Hal,Ivy,Engineer,Pylon,2024-01,CTO,Mint,`);
  const p1 = buildProfile(numbered.rows[0], planColumns(numbered.headers, numbered.rows));
  assert.deepEqual(p1.current_roles, [{ title: "CTO", company: "Mint" }]);
  // With no title or company column, the listed ones fall back to the current job.
  assert.equal(p1.listed_company, "Mint");

  const clay = csvRows(`Name,Title,Company,Experience
Cy,Head of RevOps,Loop,"[{""title"":""Head of RevOps"",""company"":""Loop"",""is_current"":true},{""title"":""Advisor"",""company"":""Glide"",""is_current"":true},{""title"":""Ops"",""company"":""Stripe"",""is_current"":false}]"
Di,CEO,Glide,[]`);
  const plan = planColumns(clay.headers, clay.rows);
  assert.equal(roleOf(plan, "Experience"), "experience_json");
  assert.deepEqual(buildProfile(clay.rows[0], plan).current_roles.map((r) => r.company), ["Loop", "Glide"]);
});

test("unrecognised columns are judged by their values", () => {
  const { headers, rows } = csvRows(`contact,org,what they do,Record Link,Imported,Tier
Eve,Brightline Clinics,Runs IT for 12 clinics,https://x.io/1,2026-09-01,A
Fay,Brightline Clinics,Intern,https://x.io/2,2026-09-01,A
Gil,Brightline Clinics,Nurse,https://x.io/3,2026-09-01,A
Hana,Brightline Clinics,CFO,https://x.io/4,2026-09-01,A
Ivo,Brightline Clinics,COO,https://x.io/5,2026-09-01,A`);
  const plan = planColumns(headers, rows);
  assert.equal(roleOf(plan, "contact"), "name");
  assert.equal(roleOf(plan, "org"), "company");
  assert.equal(roleOf(plan, "what they do"), "other");
  assert.equal(roleOf(plan, "Record Link"), "ignore");
  assert.equal(roleOf(plan, "Imported"), "ignore");
  assert.equal(roleOf(plan, "Tier"), "ignore"); // the same value on every row tells contacts apart not at all
});

test("an override beats detection", () => {
  const { headers, rows } = csvRows(`Name,Notes\nAda,Buys security tooling`);
  assert.equal(roleOf(planColumns(headers, rows), "Notes"), "other");
  const plan = planColumns(headers, rows, { Notes: "about", Name: "ignore" });
  assert.equal(buildProfile(rows[0], plan).about, "Buys security tooling");
  // The name still shows (it is never sent): identity follows the header, so a re-roled column cannot blank it.
  assert.equal(identifyWith(rows[0], plan).name, "Ada");
});

test("missingFields flags only questions with nothing to go on, and ignores fields inside roles", () => {
  const questions = [
    { key: "blind", instructions: "Does `listed_company_profile.description` describe software?" },
    { key: "partial", instructions: "Using `headline`, `about` and `past_roles` (each entry's `title`, `to` and `about`), is it likely…" },
    { key: "role_fields", instructions: "Is the entry in `current_roles` with no `to` date a director role? Check its `about`." },
  ];
  const profiles = [{ headline: "VP at Anthem", current_roles: [{ title: "VP" }] }, { headline: "Director", current_roles: [{ title: "Director" }] }, { listed_title: "CEO" }];
  // Only the question whose every field is missing for most contacts is flagged; `to` is never looked for.
  assert.deepEqual(missingFields(questions, profiles), { blind: ["listed_company_profile.description"] });
  // All present → nothing flagged.
  assert.deepEqual(missingFields([questions[0]], [{ listed_company_profile: { description: "x" } }]), {});
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

test("verdictFor: a score with vetoes — musts drop on a clear fail, exclusions only when clearly true", () => {
  const { questions } = normalizeQuestionSet({ questions: [
    { label: "Main job", type: "noul", instructions: "?" },
    { label: "Competitor", type: "noul", instructions: "?", pass: false },
    { label: "Owns purchasing", type: "noul", instructions: "?", kind: "signal" },
  ] });
  assert.deepEqual(questions.map((q) => q.kind), ["must", "exclude", "signal"]);
  const t = { keep: 0.6, drop: 0.35 };
  assert.equal(verdictFor(questions, { main_job: { noul: 0.9 }, competitor: { noul: 0.1 }, owns_purchasing: { noul: 0.7 } }, t).verdict, "good");
  // A weak signal no longer sinks a strong contact on its own — it lowers the score.
  const soft = verdictFor(questions, { main_job: { noul: 0.95 }, competitor: { noul: 0.05 }, owns_purchasing: { noul: 0.3 } }, t);
  assert.equal(soft.verdict, "good");
  assert.ok(Math.abs(soft.score - 0.625) < 1e-9);
  // A must-have clearly failed drops them.
  assert.equal(verdictFor(questions, { main_job: { noul: 0.2 }, competitor: { noul: 0.05 }, owns_purchasing: { noul: 0.9 } }, t).reason, "Failed: Main job");
  // An exclusion drops only when clearly true (≥80%)…
  assert.equal(verdictFor(questions, { main_job: { noul: 0.9 }, competitor: { noul: 0.9 }, owns_purchasing: { noul: 0.9 } }, t).reason, "Excluded: Competitor");
  // …and a 60% maybe-competitor stays in play.
  assert.equal(verdictFor(questions, { main_job: { noul: 0.9 }, competitor: { noul: 0.6 }, owns_purchasing: { noul: 0.9 } }, t).verdict, "good");
  // A must-have in between is borderline, and names itself.
  const mid = verdictFor(questions, { main_job: { noul: 0.5 }, competitor: { noul: 0.05 }, owns_purchasing: { noul: 0.9 } }, t);
  assert.equal(mid.verdict, "borderline");
  assert.equal(mid.reason, "Unsure: Main job (50%)");
  // Passing every must-have is a good fit even when a signal is weak — signals rank, they do not demote.
  const ranked = verdictFor(questions, { main_job: { noul: 0.9 }, competitor: { noul: 0.05 }, owns_purchasing: { noul: 0.1 } }, t);
  assert.equal(ranked.verdict, "good");
  assert.ok(Math.abs(ranked.score - 0.5) < 1e-9);
  // With no must-have at all, the average decides.
  const signalsOnly = normalizeQuestionSet({ questions: [{ label: "A", type: "noul", instructions: "?", kind: "signal" }, { label: "B", type: "noul", instructions: "?", kind: "signal" }] }).questions;
  assert.equal(verdictFor(signalsOnly, { a: { noul: 0.5 }, b: { noul: 0.5 } }, t).reason, "Score 50% — weakest: A");
  // A question left unanswered never silently passes a contact.
  assert.equal(verdictFor(questions, { main_job: { noul: 0.95 }, owns_purchasing: { noul: 0.9 } }, t).verdict, "borderline");
});

test("verdictFor: 'can't tell' is left out instead of failing the contact", () => {
  const { questions } = normalizeQuestionSet({ questions: [
    { label: "Facility type", type: "choice", instructions: "?", criteria: { asc: "Surgery center", other: "Other", unclear: "Not stated" }, pass: ["asc"] },
    { label: "Main job", type: "noul", instructions: "?" },
  ] });
  assert.deepEqual(questions[0].neutral, ["unclear"]);
  const thin = verdictFor(questions, { facility_type: { probabilities: { asc: 0.1, other: 0.1, unclear: 0.8 } }, main_job: { noul: 0.9 } });
  // Unchecked is not a fit: it is kept as a Maybe for review rather than shown as good.
  assert.equal(thin.verdict, "borderline");
  assert.equal(thin.reason, "can't tell: Facility type");
  // Under the old rule this was a clear fail (10% fit) and the contact was dropped.
  assert.equal(verdictFor(questions, { facility_type: { probabilities: { asc: 0.1, other: 0.8, unclear: 0.1 } }, main_job: { noul: 0.9 } }).verdict, "bad");
  // Nothing but "can't tell" is borderline, not bad.
  assert.equal(verdictFor([questions[0]], { facility_type: { probabilities: { unclear: 1 } } }).reason, "Not enough data to judge");
});

test("ICP: title pool question is built verbatim, company size is checked in code", () => {
  const icp = normalizeIcp({ titles: "Administrator\nDirector of Nursing\n- OR Director\nAdministrator", sizeMin: "10", sizeMax: "1,000" });
  assert.deepEqual(icp.titles, ["Administrator", "Director of Nursing", "OR Director"]);
  assert.equal(icp.sizeMax, 1000);
  const q = titlePoolQuestion(icp);
  assert.deepEqual(Object.keys(q.criteria), ["administrator", "director_of_nursing", "or_director", "similar_role", "not_a_target", "unclear"]);
  assert.deepEqual(q.pass, ["administrator", "director_of_nursing", "or_director", "similar_role"]);
  assert.deepEqual(q.neutral, ["unclear"]);
  assert.equal(q.kind, "must");
  assert.equal(normalizeQuestionSet({ questions: [q] }).questions[0].neutral[0], "unclear");
  assert.deepEqual(parseEmployees("10001+"), { min: 10001, max: Infinity });
  assert.deepEqual(parseEmployees("1,001-5,000 employees"), { min: 1001, max: 5000 });
  assert.equal(parseEmployees(""), null);
  assert.equal(sizeCheck(icp, { listed_company_profile: { employees: "11-50" } }), "inside");
  assert.equal(sizeCheck(icp, { listed_company_profile: { employees: "5001-10000" } }), "outside");
  assert.equal(sizeCheck(icp, { listed_company_profile: {} }), null);
  const v = verdictFor(normalizeQuestionSet({ questions: [q] }).questions, { target_role: { probabilities: { administrator: 0.9 } } }, undefined, { icp, profile: { listed_company_profile: { employees: "10001+" } } });
  assert.equal(v.reason, "Company size outside 10–1000 employees");
  assert.equal(normalizeIcp({}), null);
});

test("parseGeneratedQuestionSet reads fenced or chatty JSON and rejects nonsense", () => {
  const fenced = '```json\n{"questions":[{"label":"Main job","type":"noul","instructions":"Is it?"}]}\n```';
  assert.equal(parseGeneratedQuestionSet(fenced).questions.length, 1);
  assert.equal(parseGeneratedQuestionSet('Here you go: {"questions":[{"label":"X","type":"noul","instructions":"?"}]} Hope that helps').questions.length, 1);
  assert.equal(parseGeneratedQuestionSet("no json here").questions.length, 0);
});

test("a company export is read into the company profile, and duplicates are found by website", () => {
  const { headers, rows } = csvRows(`Company Name,Company Name for Emails,Headcount,Employee Size,Industry,Industry Tags,Product and Services,Description,SEO Description,Website,LinkedIn,Company Type,Number of Locations,Company Address,Company Country,Company State,Annual Revenue,Last Funding Type,Last Funding Amount,AI Ark Account ID
Centerstone,Centerstone,3482,10001+,mental health care,mental health care,"behavioral health, addiction",Largest nonprofit behavioral health organization.,Healing and hope.,centerstone.org,https://www.linkedin.com/company/centerstone,NON_PROFIT,4,"1 Main St, Nashville",United States,Tennessee,100000000-499999999,,,cc9
Centerstone TN,Centerstone,3482,10001+,mental health care,mental health care,,Same org.,,https://www.centerstone.org/,,NON_PROFIT,4,,United States,Tennessee,,,,cc8`);
  const plan = planColumns(headers, rows);
  assert.equal(roleOf(plan, "Company Name for Emails"), "ignore");
  assert.equal(roleOf(plan, "Website"), "website");
  assert.equal(roleOf(plan, "Number of Locations"), "company_locations");
  assert.equal(roleOf(plan, "Company Address"), "ignore");
  assert.equal(roleOf(plan, "Last Funding Amount"), "ignore");
  const p = buildCompanyProfile(rows[0], plan);
  assert.equal(p.name, "Centerstone");
  assert.equal(p.industry, "mental health care");
  assert.equal(p.description, "Largest nonprofit behavioral health organization. · Healing and hope.");
  assert.equal(p.locations, "4");
  assert.equal(JSON.stringify(p).includes("centerstone.org"), false);
  const ids = rows.map((r) => identifyCompany(r, plan));
  assert.deepEqual([...duplicateIndexes(ids)], [1]);
});

test("tag sets: labels become keys, Other is always present, confidence line is kept", () => {
  const t = normalizeTagSet({ tags: ["Health System", { label: "Children's Hospital", description: "Mainly treats children" }, "Health System"], minConfidence: 0.7 });
  assert.deepEqual(t.tags.map((x) => x.key), ["health_system", "children_s_hospital", "other"]);
  assert.equal(t.minConfidence, 0.7);
  assert.ok(t.problems.some((p) => /twice/.test(p)));
  assert.equal(normalizeTagSet({ tags: ["Only one"] }).tags.length, 2); // Other added makes it usable
  assert.equal(normalizeTagSet({ tags: [] }).tags.length, 0);
  assert.deepEqual(parseTagList("Health System | ACO |IPA"), ["Health System", "ACO", "IPA"]);
  assert.deepEqual(parseTagList("- Hospice\n- Home Health"), ["Hospice", "Home Health"]);
  assert.deepEqual(toTagWire(t).category.criteria.children_s_hospital, "Children's Hospital: Mainly treats children");
});

test("tagVerdict: top tag, runner-up when it is a contender, review below the line", () => {
  const set = normalizeTagSet({ tags: ["Behavioral Health Provider", "Telehealth / Virtual Care"], minConfidence: 0.6 });
  const sure = tagVerdict(set, { choice: "behavioral_health_provider", probabilities: { behavioral_health_provider: 0.93, telehealth_virtual_care: 0.05, other: 0.02 }, confidence: 0.92 });
  assert.equal(sure.status, "tagged");
  assert.equal(sure.label, "Behavioral Health Provider");
  assert.equal(sure.runnerUp, null);
  const unsure = tagVerdict(set, { choice: "telehealth_virtual_care", probabilities: { telehealth_virtual_care: 0.54, behavioral_health_provider: 0.46, other: 0 }, confidence: 0.52 });
  assert.equal(unsure.status, "review");
  assert.equal(unsure.runnerUp.label, "Behavioral Health Provider");
  assert.equal(unsure.reason, "Unsure: Telehealth / Virtual Care or Behavioral Health Provider");
  assert.equal(tagVerdict(set, {}).status, "error");
});

test("mergeNamedTags keeps the typed tags exactly, in order, with the model's descriptions", () => {
  const generated = parseGeneratedTagSet(JSON.stringify({ instructions: "Which?", tags: [
    { label: "PBM", description: "renamed by the model" },
    { label: "Health System", description: "Multi-hospital system" },
    { label: "Wellness Spa", description: "not asked for" },
    { label: "Other", description: "None fits" },
  ] }));
  const merged = mergeNamedTags(generated, ["Health System", "Pharmacy / PBM", "ACO"]);
  assert.deepEqual(merged.tags.map((t) => t.label), ["Health System", "Pharmacy / PBM", "ACO", "Other"]);
  assert.equal(merged.tags[0].description, "Multi-hospital system");
  assert.equal(merged.tags[1].description, "");
  assert.equal(merged.instructions, "Which?");
});

test("a typed lead-in never becomes a tag, and a set saved with one is repaired on load", () => {
  assert.deepEqual(parseTagList("Tag each company as one of the following: Health System | ACO | IPA"), ["Health System", "ACO", "IPA"]);
  const repaired = normalizeTagSet({ tags: [{ key: "tag_each_company_as_one_of_the_following_health_system", label: "tag each company as one of the following: Health System" }, { key: "aco", label: "ACO" }] });
  assert.deepEqual(repaired.tags.map((t) => [t.key, t.label]), [["health_system", "Health System"], ["aco", "ACO"], ["other", "Other"]]);
  // A real tag with a colon in it is left alone.
  assert.equal(normalizeTagSet({ tags: ["Post-Acute: Skilled Nursing", "ACO"] }).tags[0].label, "Post-Acute: Skilled Nursing");
});

test("suggestions from Other: new labels only, examples kept, added before Other", () => {
  const sample = otherSample([{ profile: { name: "Shirley Ryan AbilityLab", industry: "hospitals", from_website: { what_they_do: "Inpatient rehabilitation hospital", organization_type: "nonprofit hospital" } }, runnerUp: "Academic Medical Center" }]);
  assert.deepEqual(sample[0], { n: 1, name: "Shirley Ryan AbilityLab", industry: "hospitals", what_they_do: "Inpatient rehabilitation hospital", organization_type: "nonprofit hospital", runner_up: "Academic Medical Center" });
  const { suggestions, outOfScope } = parseSuggestions(JSON.stringify({ suggestions: [
    { label: "Rehabilitation Hospital", description: "Inpatient rehab", examples: ["Shirley Ryan AbilityLab"], count: 4 },
    { label: "ACO", description: "dupe of an existing tag" },
    { label: "Other", description: "never" },
    { label: "Dental / Orthodontics Group", description: "Dental practices", examples: ["Western Dental"], count: 3 },
  ], out_of_scope: ["Nashville Chess Center"] }), ["ACO", "Other"]);
  assert.deepEqual(suggestions.map((x) => [x.label, x.count]), [["Rehabilitation Hospital", 4], ["Dental / Orthodontics Group", 3]]);
  assert.deepEqual(outOfScope, ["Nashville Chess Center"]);
  const set = addTags(normalizeTagSet({ tags: ["Health System", "ACO"] }), suggestions);
  assert.deepEqual(set.tags.map((t) => t.label), ["Health System", "ACO", "Rehabilitation Hospital", "Dental / Orthodontics Group", "Other"]);
  assert.deepEqual(parseSuggestions("not json"), { suggestions: [], outOfScope: [] });
});

test("typed tags carry their own descriptions: 'Name: description', one per line", () => {
  const text = `tag each company as one of the following:

Health System: A multi-hospital organization that owns or operates two or more hospitals.
Community Hospital: A single independent or locally governed hospital serving a general community.
Post-Acute: Skilled Nursing
Dental / DSO — Dental practices and dental service organizations.
1. ACO
Other`;
  assert.deepEqual(parseTagEntries(text), [
    { label: "Health System", description: "A multi-hospital organization that owns or operates two or more hospitals." },
    { label: "Community Hospital", description: "A single independent or locally governed hospital serving a general community." },
    { label: "Post-Acute: Skilled Nursing", description: "" },
    { label: "Dental / DSO", description: "Dental practices and dental service organizations." },
    { label: "ACO", description: "" },
    { label: "Other", description: "" },
  ]);
  // Hyphenated names are not split.
  assert.deepEqual(parseTagEntries("Women's Health / OB-GYN | Long-Term Acute Care Hospital | IPA"), [
    { label: "Women's Health / OB-GYN", description: "" }, { label: "Long-Term Acute Care Hospital", description: "" }, { label: "IPA", description: "" },
  ]);
  assert.deepEqual(parseTagList("Tag each company as one of the following: A | B | C"), ["A", "B", "C"]);
});

test("Claude review: placements are held to the tag set, new tags are merged across batches", () => {
  const set = normalizeTagSet({ tags: ["Health System", "Rehabilitation Hospital", "Dental / DSO"] });
  const item = reviewItem(7, { name: "Shirley Ryan AbilityLab", industry: "hospitals", from_website: { what_they_do: "Inpatient rehab" } }, [{ label: "Academic Medical Center", p: 0.35 }, { label: "Other", p: 0.01 }]);
  assert.deepEqual(item.jev_top_guesses, ["Academic Medical Center (35%)"]);
  const out = parseReview({ results: [
    { id: 1, existing_tag: "rehabilitation hospital", new_tag_label: null, new_tag_description: null, confidence: "high", reason: "Inpatient rehab" },
    { id: 2, existing_tag: "Made-up Tag", new_tag_label: "Veterinary Clinic", new_tag_description: "Animal care", confidence: "medium", reason: "Vet" },
    { id: 3, existing_tag: null, new_tag_label: "Dental / DSO", new_tag_description: "dupe", confidence: "high", reason: "Dentist" },
    { id: 4, existing_tag: null, new_tag_label: null, new_tag_description: null, confidence: "low", reason: "A chess club" },
    { id: 99, existing_tag: "Health System", confidence: "high", reason: "not asked" },
  ] }, set.tags, [1, 2, 3, 4, 5]);
  assert.deepEqual(out.get(1), { kind: "existing", tag: "rehabilitation_hospital", label: "Rehabilitation Hospital", confidence: "high", reason: "Inpatient rehab" });
  assert.equal(out.get(2).kind, "new");
  assert.equal(out.get(2).label, "Veterinary Clinic");
  assert.equal(out.get(3).label, "Dental / DSO"); // a "new" tag that already exists is placed there
  assert.equal(out.get(4).kind, "unplaced");
  assert.equal(out.get(5).reason, "Claude did not answer for this company");
  assert.equal(out.has(99), false);
  const merged = mergeProposals(new Map([[10, { kind: "new", tag: "vet_clinic", label: "Vet Clinic", description: "" }], [11, { kind: "new", tag: "vet_clinic", label: "Vet Clinic", description: "Animal care" }], [12, { kind: "existing" }]]));
  assert.deepEqual(merged, [{ key: "vet_clinic", label: "Vet Clinic", description: "Animal care", rows: [10, 11] }]);
});

test("weighted scoring: every question counts the same, one fail never eliminates, the middle is maybe", () => {
  const { questions, scoring } = normalizeQuestionSet({ scoring: "weighted", questions: [
    { label: "Any Medicare connection", type: "noul", instructions: "?", kind: "signal" },
    { label: "Employer runs Medicare business", type: "noul", instructions: "?", kind: "signal" },
    { label: "Own role handles it", type: "noul", instructions: "?", kind: "signal" },
    { label: "Outside healthcare", type: "noul", instructions: "?", kind: "exclude", pass: false },
  ] });
  assert.equal(scoring, "weighted");
  const t = { keep: 0.6, drop: 0.35 };
  const ctx = { scoring: "weighted" };
  const carried = verdictFor(questions, { any_medicare_connection: { noul: 0.2 }, employer_runs_medicare_business: { noul: 0.9 }, own_role_handles_it: { noul: 0.8 }, outside_healthcare: { noul: 0.05 } }, t, ctx);
  assert.equal(carried.verdict, "good");
  assert.ok(Math.abs(carried.score - (0.2 + 0.9 + 0.8 + 0.95) / 4) < 1e-9);
  const maybe = verdictFor(questions, { any_medicare_connection: { noul: 0.5 }, employer_runs_medicare_business: { noul: 0.4 }, own_role_handles_it: { noul: 0.2 }, outside_healthcare: { noul: 0.1 } }, t, ctx);
  assert.equal(maybe.verdict, "borderline");
  assert.match(maybe.reason, /^Maybe — score 50%, weakest: Own role handles it/);
  const out = verdictFor(questions, { any_medicare_connection: { noul: 0.1 }, employer_runs_medicare_business: { noul: 0.1 }, own_role_handles_it: { noul: 0.1 }, outside_healthcare: { noul: 0.9 } }, t, ctx);
  assert.equal(out.verdict, "bad");
  const icp = normalizeIcp({ sizeMin: 100 });
  const sized = verdictFor([questions[0]], { any_medicare_connection: { noul: 0.95 } }, t, { scoring: "weighted", icp, profile: { listed_company_profile: { employees: "11-50" } } });
  assert.equal(sized.verdict, "borderline");
  assert.equal(normalizeQuestionSet({ questions: [] }).scoring, "gates");
});

test("past roles reach the profile, from numbered history and from AI Ark", () => {
  const { headers, rows } = parseCsv(`Name,Title,Experience 1 Title,Experience 1 Company,Experience 1 End Date,Experience 1 Summary,Experience 2 Title,Experience 2 Company,Experience 2 End Date,Experience 2 Summary
Ada,Director,Director,Acme Health,,Runs operations,Manager of Risk Adjustment,Humana,2021-06,Led HCC coding for Medicare Advantage members`, { asArrays: true });
  const p = buildProfile(rows[0], planColumns(headers, rows));
  assert.deepEqual(p.past_roles, [{ title: "Manager of Risk Adjustment", company: "Humana", to: "2021-06", about: "Led HCC coding for Medicare Advantage members" }]);
  assert.deepEqual(p.current_roles, [{ title: "Director", company: "Acme Health", about: "Runs operations" }]);
});

test("contact review: each maybe gets keep or drop with a reason, nothing guessed", () => {
  const item = contactReviewItem(3, { listed_title: "Director" }, [{ key: "any", label: "Any Medicare connection" }], { any: 0.52 });
  assert.deepEqual(item, { id: 3, profile: { listed_title: "Director" }, jev_scores: { "Any Medicare connection": "52%" } });
  const out = parseContactReview({ results: [{ id: 3, decision: "keep", confidence: "high", reason: "Six years at Humana in risk adjustment" }, { id: 4, decision: "maybe", confidence: "low", reason: "?" }, { id: 9, decision: "drop" }] }, [3, 4]);
  assert.deepEqual([...out.entries()], [[3, { decision: "keep", confidence: "high", reason: "Six years at Humana in risk adjustment" }]]);
});

test("weighted: a question marked must-have is still a hard line (director and up)", () => {
  const { questions } = normalizeQuestionSet({ scoring: "weighted", questions: [
    { label: "Director or above", type: "noul", instructions: "?", kind: "must" },
    { label: "Medicare connection", type: "noul", instructions: "?", kind: "signal" },
  ] });
  const t = { keep: 0.6, drop: 0.35 };
  assert.equal(verdictFor(questions, { director_or_above: { noul: 0.1 }, medicare_connection: { noul: 0.99 } }, t, { scoring: "weighted" }).reason, "Failed: Director or above");
  // Between the lines the director check is unsure, so the contact is a Maybe for review, never a good fit.
  assert.equal(verdictFor(questions, { director_or_above: { noul: 0.5 }, medicare_connection: { noul: 0.9 } }, t, { scoring: "weighted" }).verdict, "borderline");
  assert.equal(verdictFor(questions, { director_or_above: { noul: 0.8 }, medicare_connection: { noul: 0.9 } }, t, { scoring: "weighted" }).verdict, "good");
});

test("a can't-tell answer never becomes a good fit, in either scoring mode", () => {
  const { questions } = normalizeQuestionSet({ questions: [
    { label: "Director or above", type: "noul", instructions: "?", kind: "must" },
    { label: "Current role touches Medicare", type: "choice", instructions: "?", kind: "signal", criteria: { yes: "Yes", no: "No", unclear: "Can't tell" }, pass: ["yes"] },
  ] });
  const t = { keep: 0.6, drop: 0.35 };
  const unsure = { director_or_above: { noul: 0.95 }, current_role_touches_medicare: { probabilities: { yes: 0.1, no: 0.1, unclear: 0.8 } } };
  for (const scoring of ["weighted", "gates"]) {
    const v = verdictFor(questions, unsure, t, { scoring });
    assert.equal(v.verdict, "borderline", scoring);
    assert.match(v.reason, /can't tell: Current role touches Medicare/);
  }
  const checked = { director_or_above: { noul: 0.95 }, current_role_touches_medicare: { probabilities: { yes: 0.9, no: 0.05, unclear: 0.05 } } };
  assert.equal(verdictFor(questions, checked, t, { scoring: "weighted" }).verdict, "good");
});

test("duplicates: a name-less row never matches, and a re-roled LinkedIn column still identifies people", () => {
  assert.equal(duplicateIndexes([{ name: "(no name)", company: "Anthem", linkedin: "" }, { name: "(no name)", company: "Anthem", linkedin: "" }]).size, 0);
  assert.equal(duplicateIndexes([{ name: "Ada", company: "", linkedin: "" }, { name: "Ada", company: "", linkedin: "" }]).size, 0);
  assert.deepEqual([...duplicateIndexes([{ name: "Ada", company: "Anthem" }, { name: "ada", company: "anthem" }])], [1]);
  const { headers, rows } = parseCsv(`Full Name,Title,Organization,LinkedIn
Ada Lovelace,Director,Anthem,https://www.linkedin.com/in/ada
Grace Hopper,VP,Anthem,https://www.linkedin.com/in/grace`, { asArrays: true });
  const plan = planColumns(headers, rows, { LinkedIn: "other", "Full Name": "other" });
  const people = rows.map((r) => identifyWith(r, plan));
  assert.deepEqual(people.map((p) => [p.name, p.linkedin]), [["Ada Lovelace", "https://www.linkedin.com/in/ada"], ["Grace Hopper", "https://www.linkedin.com/in/grace"]]);
  assert.equal(duplicateIndexes(people).size, 0);
});

test("always-keep terms: 'MA' only as a real word, never in locations, degrees or inside other words", () => {
  const headers = ["Headline", "Summary", "Location", "1st Education Degree", "Company Product and Services", "Full Name", "Skills"];
  const find = (row) => findKeepTerm(row, headers, null, "MA, Medicare Advantage, MA-PD");
  assert.equal(find(["Manufacturer of devices", "Email me · Management consulting", "Boston, MA 02110", "MA in Psychology", "", "Jane Doe, MA", "Massage"]), null);
  assert.equal(find(["", "Lives in Boston, MA. Earned my MA in counseling.", "", "", "", "", ""]), null);
  assert.equal(find(["Jane Doe, MA, LPC", "", "", "", "", "", ""]), null);
  assert.deepEqual(find(["Director, MA Operations", "", "", "", "", "", ""]), { term: "MA", column: "Headline", snippet: "Director, MA Operations" });
  assert.equal(find(["", "Led our MA plan growth", "", "", "", "", ""]).column, "Summary");
  assert.equal(find(["", "Stars ratings for medicare advantage plans", "", "", "", "", ""]).term, "Medicare Advantage");
  // The employer's description says nothing about the person: on a curated Medicare list it matched every row.
  assert.equal(find(["", "", "", "", "Stars ratings for medicare advantage plans", "", ""]), null);
  assert.deepEqual(applyKeepTerm("bad", "Failed: Director or above", { term: "MA", column: "Summary" }), { verdict: "borderline", reason: 'Kept: mentions "MA" in Summary (Jev: Failed: Director or above)' });
  assert.equal(applyKeepTerm("good", "", { term: "MA", column: "Summary" }).verdict, "good");
  assert.deepEqual(applyKeepTerm("bad", "x", null), { verdict: "bad", reason: "x" });
});

test("compactAnswers keeps what Jev said for every question", () => {
  const { questions } = normalizeQuestionSet({ questions: [
    { label: "Director", type: "noul", instructions: "?" },
    { label: "Level", type: "choice", instructions: "?", criteria: { exec: "x", director: "y", ic: "z" }, pass: ["exec", "director"] },
  ] });
  assert.deepEqual(compactAnswers(questions, { director: { noul: 0.83 }, level: { choice: "director", probabilities: { exec: 0.3, director: 0.65, ic: 0.05 }, confidence: 0.6 } }), {
    director: { yes: 0.83 },
    level: { choice: "director", p: 0.65, second: "exec 30%", confidence: 0.6 },
  });
});

test("cleaned export: original headers and cells survive a round trip, and a duplicate points at its first copy", () => {
  const src = `First Name,LinkedIn,Summary\r\nAda,https://www.linkedin.com/in/ada,"Runs Medicare, Medicaid ""MA"" plans\nat Humana"\r\nGrace,https://www.linkedin.com/in/grace,\r\nAda,https://linkedin.com/in/ada/,dup`;
  const a = parseCsv(src, { asArrays: true });
  assert.deepEqual(parseCsv(toCsv(a.headers, a.rows), { asArrays: true }), a);
  assert.deepEqual([...duplicateOf(a.rows.map((r) => ({ name: r[0], linkedin: r[1] })))], [[2, 0]]);
});

test("weighted: passing the director gate never adds to the score", () => {
  const { questions } = normalizeQuestionSet({ scoring: "weighted", questions: [
    { label: "Director or above", type: "noul", instructions: "?", kind: "must" },
    { label: "Current role works on MA", type: "noul", instructions: "?", kind: "signal" },
    { label: "Past roles worked on MA", type: "noul", instructions: "?", kind: "signal" },
  ] });
  const t = { keep: 0.6, drop: 0.35 };
  // Averaged with the gate this was (0.99 + 0.5 + 0.3) / 3 = 60% — a good fit on seniority alone.
  const v = verdictFor(questions, { director_or_above: { noul: 0.99 }, current_role_works_on_ma: { noul: 0.5 }, past_roles_worked_on_ma: { noul: 0.3 } }, t, { scoring: "weighted" });
  assert.equal(v.verdict, "borderline");
  assert.ok(Math.abs(v.score - 0.4) < 1e-9);
  assert.equal(verdictFor(questions, { director_or_above: { noul: 0.1 }, current_role_works_on_ma: { noul: 0.99 }, past_roles_worked_on_ma: { noul: 0.99 } }, t, { scoring: "weighted" }).verdict, "bad");
});

test("weighted: good needs most signals answered — one confident yes among can't-tells stays a maybe", () => {
  const c = (label) => ({ label, type: "choice", instructions: "?", kind: "signal", criteria: { yes: "y", no: "n", unclear: "?" }, pass: ["yes"] });
  const { questions } = normalizeQuestionSet({ scoring: "weighted", questions: [{ label: "Director", type: "noul", instructions: "?", kind: "must" }, c("Current"), c("Past"), c("Headline")] });
  const t = { keep: 0.6, drop: 0.35 };
  const yes = { probabilities: { yes: 0.95, no: 0.03, unclear: 0.02 } };
  const unsure = { probabilities: { yes: 0.05, no: 0.05, unclear: 0.9 } };
  // No past roles on file is not doubt about the current role: two clear yeses make a good fit.
  assert.equal(verdictFor(questions, { director: { noul: 0.99 }, current: yes, past: unsure, headline: yes }, t, { scoring: "weighted" }).verdict, "good");
  assert.equal(verdictFor(questions, { director: { noul: 0.99 }, current: unsure, past: yes, headline: unsure }, t, { scoring: "weighted" }).verdict, "borderline");
});

test("key question: required for a good fit, never drops anyone alone; good fits say why", () => {
  const c = (label, kind = "signal") => ({ label, type: "choice", instructions: "?", kind, criteria: { yes: "y", no: "n", unclear: "?" }, pass: ["yes"] });
  const { questions } = normalizeQuestionSet({ scoring: "weighted", questions: [{ label: "Director", type: "noul", instructions: "?", kind: "must" }, c("Current role works on MA", "key"), c("Past roles"), c("Headline")] });
  assert.equal(questions[1].kind, "key");
  const t = { keep: 0.6, drop: 0.35 };
  const yes = { probabilities: { yes: 0.95, no: 0.03, unclear: 0.02 } };
  const no = { probabilities: { yes: 0.02, no: 0.95, unclear: 0.03 } };
  const unsure = { probabilities: { yes: 0.05, no: 0.05, unclear: 0.9 } };
  const ctx = { scoring: "weighted" };
  // "Associate Director of Operations" with an MA past and headline: the current role is unproven, so a maybe.
  const linda = verdictFor(questions, { director: { noul: 0.9 }, current_role_works_on_ma: unsure, past_roles: yes, headline: yes }, t, ctx);
  assert.equal(linda.verdict, "borderline");
  assert.equal(linda.reason, "Maybe — can't tell: Current role works on MA");
  assert.equal(verdictFor(questions, { director: { noul: 0.9 }, current_role_works_on_ma: no, past_roles: yes, headline: yes }, t, ctx).verdict, "borderline");
  const dawn = verdictFor(questions, { director: { noul: 0.99 }, current_role_works_on_ma: yes, past_roles: unsure, headline: yes }, t, ctx);
  assert.equal(dawn.verdict, "good");
  assert.equal(dawn.reason, "Yes: Current role works on MA (95%) · Headline (95%) · can't tell: Past roles");
  assert.equal(verdictFor(questions, { director: { noul: 0.99 }, current_role_works_on_ma: unsure, past_roles: yes, headline: yes }, t, {}).verdict, "borderline");
});

test("a 'no' answer is never counted as can't-tell, even when the writer lists it", () => {
  const { questions } = normalizeQuestionSet({ questions: [{ label: "Current role", type: "choice", instructions: "?", criteria: { yes: "y", no: "n", unclear: "?" }, pass: ["yes"], neutral: ["no", "unclear"] }] });
  assert.deepEqual(questions[0].neutral, ["unclear"]);
});
