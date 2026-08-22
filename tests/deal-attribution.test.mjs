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
