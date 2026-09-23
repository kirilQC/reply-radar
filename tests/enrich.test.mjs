// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import {
  afterFirstPass,
  aiArkEvidence,
  aiArkFacts,
  evidenceOf,
  mergeAiArk,
  htmlToText,
  linkedinProfileUrl,
  mergeStructured,
  missingData,
  scrapeTarget,
  splitBatchAnswer,
  structureBatchInput,
  structureBatchSchema,
  structureSchema,
  unusablePage,
  websiteUrl,
} from "../shared/enrich.mjs";

test("scrape targets: LinkedIn /in/ profiles only, company sites on their bare host", () => {
  assert.equal(linkedinProfileUrl("http://linkedin.com/in/ada-lee?trk=x"), "https://www.linkedin.com/in/ada-lee/");
  assert.equal(linkedinProfileUrl("https://www.linkedin.com/sales/lead/ACwAA"), "");
  assert.equal(linkedinProfileUrl("https://www.linkedin.com/company/acme"), "");
  assert.equal(websiteUrl("www.Acme.com/"), "https://Acme.com".replace("A", "a"));
  assert.equal(websiteUrl("https://acme.com/about/"), "https://acme.com/about");
  assert.equal(websiteUrl("linkedin.com/company/acme"), "");
  assert.equal(websiteUrl("not a url"), "");
  assert.equal(scrapeTarget("companies", { company: "centerstone.org" }), "https://centerstone.org");
  assert.equal(scrapeTarget("contacts", { linkedin: "linkedin.com/in/bo" }), "https://www.linkedin.com/in/bo/");
});

test("missingData: a company needs a real description; a contact needs their own words and current roles", () => {
  assert.deepEqual(missingData("companies", { name: "X", industry: "mental health care" }), ["description"]);
  assert.deepEqual(missingData("companies", { description: "x".repeat(200) }), []);
  assert.deepEqual(missingData("companies", { from_website: { what_they_do: "y".repeat(200) } }), []);
  assert.deepEqual(missingData("contacts", { listed_title: "CEO" }), ["headline or about", "current_roles"]);
  assert.deepEqual(missingData("contacts", { headline: "CEO at Acme", current_roles: [{ title: "CEO" }] }), []);
  // A field the client's questions name counts too.
  assert.deepEqual(missingData("contacts", { headline: "CEO at Acme", current_roles: [{}] }, ["listed_company_profile.description"]), ["listed_company_profile.description"]);
});

test("afterFirstPass: clear fails are never scraped, thin confident rows are, off and all do what they say", () => {
  const bad = { status: "bad", scores: { a: 0.05, b: 0.9 } };
  const softBad = { status: "bad", scores: { a: 0.3, b: 0.9 } };
  const good = { status: "good", scores: { a: 0.9 } };
  assert.equal(afterFirstPass("contacts", bad, ["headline or about"]), "ruled_out");
  assert.equal(afterFirstPass("contacts", softBad, []), "enrich");
  assert.equal(afterFirstPass("contacts", good, []), "decided");
  assert.equal(afterFirstPass("contacts", good, ["current_roles"]), "enrich");
  assert.equal(afterFirstPass("contacts", { status: "borderline", scores: { a: 0.5 } }, []), "enrich");
  assert.equal(afterFirstPass("companies", { status: "tagged" }, []), "decided");
  assert.equal(afterFirstPass("companies", { status: "tagged" }, ["description"]), "enrich");
  assert.equal(afterFirstPass("companies", { status: "review" }, []), "enrich");
  assert.equal(afterFirstPass("contacts", bad, [], "all"), "enrich");
  assert.equal(afterFirstPass("contacts", softBad, ["x"], "off"), "decided");
  assert.equal(afterFirstPass("contacts", null, []), "enrich");
});

test("htmlToText keeps what a reader sees and drops scripts, styles, nav and footer", () => {
  const html = `<html><head><title>Acme &amp; Co</title><meta name="description" content="We build billing software"><style>.x{}</style><script>var a=1</script></head>
  <body><nav>Home About Login</nav><h1>Billing for SaaS</h1><p>Acme&rsquo;s platform handles invoices.</p><footer>© 2026 Cookie settings</footer></body></html>`;
  const page = htmlToText(html);
  assert.equal(page.title, "Acme & Co");
  assert.equal(page.description, "We build billing software");
  assert.equal(page.text, "Billing for SaaS\nAcme's platform handles invoices.");
});

test("unusablePage catches the firewall page that fooled a model in testing", () => {
  assert.equal(unusablePage({ title: "406", text: "Not Acceptable! An appropriate representation of the requested resource could not be found on this server." + " ".repeat(20) + "x".repeat(40) }), "blocked by the site's firewall");
  assert.equal(unusablePage({ title: "Just a moment...", text: "Checking your browser before accessing. Verify you are human. " + "y".repeat(100) }), "behind a bot check");
  assert.equal(unusablePage({ text: "hi" }), "page had almost no text");
  assert.equal(unusablePage({ text: "z".repeat(500) }, 503), "HTTP 503");
  assert.equal(unusablePage({ title: "Centerstone", text: "Centerstone provides mental health and addiction care across nine states. ".repeat(4) }), "");
});

test("structureSchema is strict: every field required, nulls allowed, no extras", () => {
  for (const mode of ["companies", "contacts"]) {
    const s = structureSchema(mode);
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
  }
});

test("mergeStructured: website facts go under from_website; LinkedIn fills only what the CSV left empty", () => {
  const co = mergeStructured("companies", { name: "Checkpoint", industry: "mental health care" }, { what_they_do: "Cloud EHR for behavioral health providers", industry: "behavioral health EHR software", products: null, customers: "Therapists", organization_type: "null", employees: null, locations: null, evidence: [] });
  assert.equal(co.profile.industry, "mental health care"); // the CSV is never overwritten
  assert.deepEqual(co.profile.from_website, { what_they_do: "Cloud EHR for behavioral health providers", industry: "behavioral health EHR software", customers: "Therapists" });
  assert.deepEqual(co.filled, ["what_they_do", "industry", "customers"]);

  const person = mergeStructured("contacts", { listed_title: "Co-founder / Sr Board Advisor", listed_company: "Lumenuity", headline: "CEO | Launch i/o" },
    { headline: "Different", about: "Supply chain consultant", current_title: "Founder & CEO", current_company: "Launch i/o", current_roles: [{ title: "Founder & CEO", company: "Launch i/o", since: null }], location: null, evidence: [] });
  assert.equal(person.profile.headline, "CEO | Launch i/o");
  assert.equal(person.profile.about, "Supply chain consultant");
  assert.deepEqual(person.profile.current_roles, [{ title: "Founder & CEO", company: "Launch i/o" }]);
  assert.deepEqual(person.profile.from_linkedin, { title: "Founder & CEO", company: "Launch i/o" });
  assert.deepEqual(person.filled, ["about", "current_roles", "from_linkedin"]);
});

test("evidence is cleaned for display", () => {
  assert.deepEqual(evidenceOf({ evidence: [{ field: "name", quote: "  The Nashville Chess Center " }, "loose quote", { field: "x", quote: "" }] }), [{ field: "name", quote: "The Nashville Chess Center" }, { field: "", quote: "loose quote" }]);
});

// AI Ark's documented People Search example, cut to the fields the mapping reads.
const ARK_PERSON = {
  profile: { headline: "CEO of Voda Cleaning and Restoration", title: "Chief Executive Officer & Co-Founder", summary: "Dan Claps is an accomplished entrepreneur." },
  location: { default: "New York, New York, United States, North America" },
  position_groups: [
    { company: { name: "Voda Cleaning & Restoration" }, profile_positions: [{ company: "Voda Cleaning & Restoration", title: "Chief Executive Officer & Co-Founder", employment_type: "Full-time", date: { start: "2023-01-01", end: null } }] },
    { company: { name: "Titus Center for Franchising" }, profile_positions: [{ company: "Titus Center for Franchising", title: "Advisory Board Member", employment_type: "Freelance", date: { start: "2025-01-01", end: null } }] },
    { company: { name: "Murphy Business" }, profile_positions: [{ company: "Murphy Business", title: "Advisor", date: { start: "2019-01-01", end: "2022-12-31" } }] },
  ],
  company: { summary: { name: "Voda Cleaning & Restoration", description: "Voda is elevating the standards of cleaning.", industry: "consumer services", staff: { range: { start: 11, end: 50 } } }, keywords: ["carpet cleaning", "water damage restoration"] },
  department: { departments: ["operations", "business_development"], seniority: "founder" },
};

test("aiArkFacts: current roles are the open-ended ones, with employment type; company facts come along", () => {
  const f = aiArkFacts(ARK_PERSON);
  assert.deepEqual(f.current_roles.map((r) => [r.company, r.employment_type]), [["Voda Cleaning & Restoration", "Full-time"], ["Titus Center for Franchising", "Freelance"]]);
  assert.equal(f.current_company, "Voda Cleaning & Restoration");
  assert.equal(f.company_employees, "11-50");
  assert.equal(f.company_products, "carpet cleaning, water damage restoration");
  assert.equal(f.department, "operations, business_development");
  assert.equal(aiArkFacts(null).current_roles.length, 0);
});

test("mergeAiArk: fills what the list lacks, exposes a side-role listing, and never pins the wrong employer's description", () => {
  const sideRole = mergeAiArk({ listed_title: "Advisory Board Member", listed_company: "Titus Center for Franchising" }, ARK_PERSON);
  assert.equal(sideRole.profile.headline, "CEO of Voda Cleaning and Restoration");
  assert.deepEqual(sideRole.profile.from_linkedin, { title: "Chief Executive Officer & Co-Founder", company: "Voda Cleaning & Restoration" });
  assert.equal(sideRole.profile.seniority, "founder");
  assert.equal(sideRole.profile.listed_company_profile, undefined); // Voda's description is not Titus Center's
  const main = mergeAiArk({ listed_title: "CEO", listed_company: "Voda Cleaning & Restoration", headline: "From the CSV" }, ARK_PERSON);
  assert.equal(main.profile.headline, "From the CSV"); // the CSV is never overwritten
  assert.equal(main.profile.listed_company_profile.description, "Voda is elevating the standards of cleaning.");
  assert.ok(main.filled.includes("listed_company_profile.industry"));
  assert.deepEqual(aiArkEvidence(main.facts).map((e) => e.field), ["headline", "title", "company"]);
  // The ended Murphy Business job comes back as a past role.
  assert.deepEqual(main.profile.past_roles, [{ title: "Advisor", company: "Murphy Business", from: "2019-01-01", to: "2022-12-31" }]);
});

test("batched structuring: every row carries its id, and answers are split back without crossing rows", () => {
  const schema = structureBatchSchema("companies");
  assert.deepEqual(schema.required, ["rows"]);
  assert.equal(schema.properties.rows.items.required[0], "id");
  const input = structureBatchInput("companies", [{ i: 4, profile: { name: "A" }, source: { url: "https://a.com", text: "Alpha" } }, { i: 9, profile: { name: "B" }, source: { url: "https://b.com", text: "Beta" } }]);
  assert.ok(input.indexOf("=== ROW 4 ===") < input.indexOf("Alpha") && input.indexOf("Alpha") < input.indexOf("=== ROW 9 ===") && input.indexOf("=== ROW 9 ===") < input.indexOf("Beta"));
  const out = splitBatchAnswer({ rows: [{ id: 9, what_they_do: "b" }, { id: 4, what_they_do: "a" }, { id: 4, what_they_do: "dupe" }, { id: 77, what_they_do: "stranger" }] }, [4, 9]);
  assert.deepEqual([...out.entries()], [[9, { what_they_do: "b" }], [4, { what_they_do: "a" }]]);
  assert.equal(splitBatchAnswer({}, [1]).size, 0);
});
