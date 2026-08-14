/**
 * "List the CISOs in our database" is the question that exposed the gap these tests guard.
 *
 * Job titles in `rr_leads` are free text, copied from whatever each person wrote on LinkedIn. There
 * is no canonical title, so a search is always a set of guesses — "CISO", "Chief Information Security
 * Officer", "Chief Security Officer" — and the filter that carries those guesses to PostgREST is
 * string-built. That is the dangerous part: a filter with a stray comma, bracket or dot does not
 * error, it parses as a *different* filter and returns a confidently wrong list of people.
 *
 * So what is asserted here is the shape of the expression, character for character.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { containsAny } from "../shared/postgrest-filter.mjs";

test("one fragment is a quoted, case-insensitive contains", () => {
  assert.equal(containsAny("role", "CISO"), 'role.ilike."*CISO*"');
});

test("several fragments are an OR, because one title has many spellings", () => {
  // The whole reason the argument is a list. Anyone matching any spelling has to come back.
  assert.equal(
    containsAny("role", ["CISO", "Chief Information Security Officer"]),
    'or(role.ilike."*CISO*",role.ilike."*Chief%20Information%20Security%20Officer*")',
  );
});

test("nothing to match on produces no condition at all", () => {
  // Not an empty string dropped into the query, which would be `and=()` and match everyone.
  assert.equal(containsAny("role", undefined), "");
  assert.equal(containsAny("role", []), "");
  assert.equal(containsAny("role", "   "), "");
  assert.equal(containsAny("role", ["", null]), "");
});

test("a dotted title stays one pattern instead of becoming new syntax", () => {
  // The bug that made quoting non-optional. "." separates column from operator from value, so
  // `role.ilike.*V.P. of Engineering*` is read as an operator PostgREST does not have.
  const filter = containsAny("role", "V.P. of Engineering");
  assert.equal(filter, 'role.ilike."*V.P.%20of%20Engineering*"');
  assert.ok(filter.endsWith('*"'), "the pattern must stay inside its quotes");
});

test("the characters that would break out of the quoting are stripped", () => {
  // A title like 'VP, Security (EMEA)' would otherwise be read as several conditions and an
  // unbalanced bracket — a filter that runs and returns the wrong people.
  const filter = containsAny("role", 'VP, Security (EMEA) "acting"');
  assert.equal(filter, 'role.ilike."*VP%20Security%20EMEA%20acting*"');
  const pattern = filter.slice('role.ilike."'.length, -1);
  assert.ok(!/[,()"\\]/.test(pattern), "no grammar character survives into the pattern");
});

test("a lone asterisk cannot be smuggled in as a wildcard", () => {
  // `*` is the wildcard this builder adds itself; one inside a fragment would widen the search
  // silently, so "C*O" must not quietly match every C-level.
  assert.equal(containsAny("role", "C*O"), 'role.ilike."*C%20O*"');
});

test("a fragment that is only punctuation is dropped rather than matching everyone", () => {
  assert.equal(containsAny("company", "()"), "");
  assert.equal(containsAny("company", ["Stripe", ","]), 'company.ilike."*Stripe*"');
});

test("the column is honoured, so role, company and name combine under one and()", () => {
  // PostgREST keeps only one `or=` parameter, which is why these come back embedded and get folded
  // into a single top-level `and=(…)` rather than being separate query parameters.
  const conditions = [
    containsAny("role", ["CISO", "Chief Security"]),
    containsAny("company", "Stripe"),
  ].filter(Boolean);
  assert.equal(
    `and=(${conditions.join(",")})`,
    'and=(or(role.ilike."*CISO*",role.ilike."*Chief%20Security*"),company.ilike."*Stripe*")',
  );
});
