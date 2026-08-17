// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The lead database's sort orders.
 *
 * Worth testing because every way this breaks is silent. An id the API does not recognise falls back
 * to newest-first, so a mislabelled entry shows a sort that never happened and the table simply looks
 * like the data happened to arrive that way. A text sort without a tiebreaker pages correctly right
 * up until two leads share a client name, and then quietly shows rows twice. A column that is not
 * really a column takes the whole route to a 502 the first time somebody picks it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_LEAD_SORT, LEAD_SORTS, leadSortOrder } from "../app/lib/lead-sort.ts";

/** The columns `rr_leads` actually has, read from the schema rather than restated here. */
const leadColumns = (() => {
  const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const table = schema.slice(schema.indexOf("create table if not exists rr_leads"));
  const body = table.slice(0, table.indexOf("\n);"));
  return new Set(
    body
      .split(/[\n,]/)
      .map((line) => line.trim().match(/^([a-z_]+)\s+(uuid|text|jsonb|timestamptz|integer)\b/)?.[1])
      .filter(Boolean),
  );
})();

test("every sort orders by columns that exist on rr_leads", () => {
  // A generated-stored column is as real as any other to `order=`, which is the whole reason the
  // rollup ones can be sorted in the database instead of across one loaded page.
  for (const sort of LEAD_SORTS) {
    for (const term of sort.order.split(",")) {
      const column = term.split(".")[0];
      assert.ok(
        leadColumns.has(column),
        `${sort.id} orders by "${column}", which is not a column on rr_leads`,
      );
    }
  }
});

test("text sorts carry a tiebreaker so paging cannot repeat or skip a row", () => {
  for (const sort of LEAD_SORTS) {
    const terms = sort.order.split(",");
    if (terms[0].startsWith("created_at")) continue;
    assert.equal(
      terms.at(-1),
      "created_at.desc",
      `${sort.id} sorts on a non-unique column with nothing to break ties`,
    );
  }
});

test("text sorts put empty values last rather than first", () => {
  // A lead can reach the database before its rollup is filled in. Without this, choosing "Client A–Z"
  // opens on a page of blanks, which reads as a broken table rather than as incomplete data.
  for (const sort of LEAD_SORTS) {
    if (sort.order.startsWith("created_at")) continue;
    assert.match(sort.order.split(",")[0], /\.(asc|desc)\.nullslast$/, `${sort.id} does not sink nulls`);
  }
});

test("ids are unique, so no label can shadow another's order", () => {
  assert.equal(new Set(LEAD_SORTS.map((sort) => sort.id)).size, LEAD_SORTS.length);
  assert.equal(new Set(LEAD_SORTS.map((sort) => sort.label)).size, LEAD_SORTS.length);
});

test("every offered id resolves to its own order", () => {
  for (const sort of LEAD_SORTS) assert.equal(leadSortOrder(sort.id), sort.order);
});

test("an unknown, blank, or missing sort falls back to the default", () => {
  // Stale bookmarks and hand-edited query strings both land here, and the table appearing in its
  // usual order is a better answer than a 400.
  for (const value of ["", "   ", "replies-desc", "name", null, undefined]) {
    assert.equal(leadSortOrder(value), DEFAULT_LEAD_SORT.order);
  }
});

test("the default is newest first", () => {
  // The page shows this as the dropdown's placeholder and sends no `sort` for it, so the two sides
  // agree only as long as the API's fallback is this one.
  assert.equal(DEFAULT_LEAD_SORT.order, "created_at.desc");
});
