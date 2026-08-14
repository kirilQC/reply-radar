// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Building one PostgREST filter expression safely.
 *
 * This exists because of "list the CISOs in our database". Job titles in `rr_leads` are free text,
 * copied from whatever each person typed on LinkedIn, so there is no canonical title to look up — a
 * search is always a set of guesses ("CISO", "Chief Information Security Officer") and the filter
 * carrying them is assembled by string concatenation.
 *
 * That is the part worth isolating. PostgREST's expression grammar is made of commas, brackets, dots
 * and asterisks, and a job title can contain all four — "VP, Security (EMEA)", "Sr. Director",
 * "V.P. of Engineering". Pasted straight in, none of those raise an error; each parses as a
 * *different, valid* filter and returns a confidently wrong list of people.
 *
 * Two defences, because either alone leaks. The pattern is wrapped in double quotes, which is how
 * PostgREST is told that dots and spaces inside it are data rather than syntax. And the characters
 * that would end that quoting or restructure the expression are stripped from the fragment first.
 *
 * It lives in `shared/` as plain ESM so `tests/assistant-lead-search.test.mjs` can hold it to its
 * exact output — this is string-built SQL-adjacent code, and "looks right" is not a check.
 */

const text = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

/**
 * One condition for "this column contains any of these fragments", case-insensitively.
 *
 * Returned in *embedded* form — `role.ilike.*ciso*`, or `or(a,b)` for several — rather than as a
 * query parameter, because a search usually has more than one of these and PostgREST silently keeps
 * only one of two `or=` parameters. The caller folds them all into a single top-level `and=(…)`.
 *
 * An empty string comes back when there is nothing to match on, and the caller must drop it rather
 * than pass it along: `and=()` is not a narrower search, it is every row in the table.
 */
export function containsAny(column, raw) {
  const fragments = (Array.isArray(raw) ? raw : [raw])
    .map((value) => text(value).replace(/[,()*"\\]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!fragments.length) return "";
  const terms = fragments.map((fragment) => `${column}.ilike."*${encodeURIComponent(fragment)}*"`);
  return terms.length === 1 ? terms[0] : `or(${terms.join(",")})`;
}
