// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEmail, normalizeLinkedin, normalizeDomain, buildQcIdentity, attributeDeal } from "../shared/deal-attribution.mjs";

test("normalizeEmail lowercases valid emails and rejects non-emails", () => {
  assert.equal(normalizeEmail("  Jane@Acme.COM "), "jane@acme.com");
  assert.equal(normalizeEmail("not an email"), "");
  assert.equal(normalizeEmail(""), "");
});

test("normalizeLinkedin reduces any profile URL shape to the handle, and rejects company pages", () => {
  assert.equal(normalizeLinkedin("https://www.linkedin.com/in/jane-doe-1a2b3c/"), "jane-doe-1a2b3c");
  assert.equal(normalizeLinkedin("linkedin.com/in/jane-doe-1a2b3c?utm=x"), "jane-doe-1a2b3c");
  assert.equal(normalizeLinkedin("https://www.linkedin.com/company/acme"), "", "a company page is not a person");
  assert.equal(normalizeLinkedin("nonsense"), "");
});

test("normalizeDomain strips scheme, www and path", () => {
  assert.equal(normalizeDomain("https://www.Acme.com/pricing"), "acme.com");
  assert.equal(normalizeDomain("acme.com"), "acme.com");
  assert.equal(normalizeDomain("not a domain"), "");
});

test("a deal contact whose email matches a booked meeting is confirmed, citing the meeting", () => {
  const qc = buildQcIdentity({ meetings: [{ email: "Maria@AtHomeHarmony.com", campaign: "SW015", domain: "athomeharmony.com" }] });
  const result = attributeDeal({ contacts: [{ email: "maria@athomeharmony.com", name: "Maria T" }], companyDomain: "athomeharmony.com" }, qc);
  assert.equal(result.attribution, "confirmed");
  assert.equal(result.matchedBy, "email");
  assert.match(result.reason, /booked a meeting through QC/);
  assert.match(result.reason, /SW015/);
});

test("a deal contact whose LinkedIn matches a campaigned lead is confirmed", () => {
  const qc = buildQcIdentity({ leads: [{ linkedin: "https://www.linkedin.com/in/dana-lee/", campaign: "BV007", name: "Dana Lee" }] });
  const result = attributeDeal({ contacts: [{ linkedin: "linkedin.com/in/dana-lee", name: "Dana Lee" }] }, qc);
  assert.equal(result.attribution, "confirmed");
  assert.equal(result.matchedBy, "linkedin");
  assert.match(result.reason, /contacted in BV007/);
});

test("email match wins over a mere domain match, and reports the person", () => {
  const qc = buildQcIdentity({ meetings: [{ email: "vp@acme.com", campaign: "X", domain: "acme.com" }] });
  const result = attributeDeal({ contacts: [{ email: "vp@acme.com" }], companyDomain: "acme.com" }, qc);
  assert.equal(result.matchedBy, "email");
  assert.deepEqual(result.evidence, { email: "vp@acme.com" });
});

test("only the company domain matching is 'possible', never 'confirmed'", () => {
  const qc = buildQcIdentity({ meetings: [{ email: "someone@acme.com", domain: "acme.com" }] });
  const result = attributeDeal({ contacts: [{ email: "other-person@acme.com" }], companyName: "Acme", companyDomain: "acme.com" }, qc);
  assert.equal(result.attribution, "possible");
  assert.equal(result.matchedBy, "domain");
  assert.match(result.reason, /no specific person on this deal matched/);
});

test("no shared identifier is 'none'", () => {
  const qc = buildQcIdentity({ meetings: [{ email: "someone@acme.com", domain: "acme.com" }] });
  const result = attributeDeal({ contacts: [{ email: "stranger@elsewhere.com" }], companyDomain: "elsewhere.com" }, qc);
  assert.equal(result.attribution, "none");
  assert.equal(result.matchedBy, null);
});

test("a meeting overrides a lead on the same person, so the confirmed reason cites the stronger signal", () => {
  const qc = buildQcIdentity({
    leads: [{ email: "sam@acme.com", campaign: "cold-touch" }],
    meetings: [{ email: "sam@acme.com", campaign: "SW020" }],
  });
  const result = attributeDeal({ contacts: [{ email: "sam@acme.com" }] }, qc);
  assert.match(result.reason, /booked a meeting through QC/);
});

test("a deal at a company QC campaigned into — but a different person — is 'possible', not lost", () => {
  // The gap the redesign exposed: QC ran a campaign into Providence but the CRM deal's contact is someone
  // else, and no LinkedIn is on the CRM record. Under the old rule this vanished; now it surfaces for review.
  const qc = buildQcIdentity({ leads: [{ company: "Providence Health, Inc.", campaign: "BV002", name: "Lisa Ivanjack", linkedin: "linkedin.com/in/lisa-ivanjack" }] });
  const result = attributeDeal({ companyName: "Providence Health", contacts: [{ name: "Someone Else In Procurement" }] }, qc);
  assert.equal(result.attribution, "possible");
  assert.equal(result.matchedBy, "company");
  assert.match(result.reason, /BV002/);
});

test("the exact person still wins as 'confirmed' over the company match", () => {
  const qc = buildQcIdentity({ leads: [{ company: "Providence", campaign: "BV002", linkedin: "linkedin.com/in/lisa-ivanjack", name: "Lisa Ivanjack" }] });
  const result = attributeDeal({ companyName: "Providence", contacts: [{ linkedin: "https://www.linkedin.com/in/lisa-ivanjack/", name: "Lisa Ivanjack" }] }, qc);
  assert.equal(result.attribution, "confirmed");
  assert.equal(result.matchedBy, "linkedin");
});

test("a lead's enriched domain raises a domain-level possible", () => {
  const qc = buildQcIdentity({ leads: [{ company: "Acme", domain: "https://acme.io", campaign: "BV009" }] });
  const result = attributeDeal({ companyName: "Acme Inc", companyDomain: "acme.io", contacts: [{ name: "Nobody Matched" }] }, qc);
  assert.equal(result.attribution, "possible");
  assert.equal(result.matchedBy, "domain");
});

test("a company QC never touched stays 'none'", () => {
  const qc = buildQcIdentity({ leads: [{ company: "Providence", campaign: "BV002" }] });
  const result = attributeDeal({ companyName: "Totally Unrelated Corp", contacts: [{ name: "X" }] }, qc);
  assert.equal(result.attribution, "none");
});

test("a two-character or filler company name never matches", () => {
  const qc = buildQcIdentity({ leads: [{ company: "The Group", campaign: "X" }] });
  // "The Group" reduces to "" (both are stripped), so it can never collide with another deal.
  const result = attributeDeal({ companyName: "The Group", contacts: [] }, qc);
  assert.equal(result.attribution, "none");
});
