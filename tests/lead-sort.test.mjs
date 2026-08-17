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

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");

/**
 * The columns `rr_lead_index` actually has, read from the schema rather than restated here.
 *
 * The view is `select l.*` over `rr_leads` plus two joined columns, so the set is the table's own
 * columns and whatever the view adds. Parsed from both so that dropping either side of that — the
 * generated `client_names`, or the `last_reply_at` join — fails here rather than in production.
 */
const leadColumns = (() => {
  const table = schema.slice(schema.indexOf("create table if not exists rr_leads"));
  const body = table.slice(0, table.indexOf("\n);"));
  const columns = new Set(
    body
      .split(/[\n,]/)
      .map((line) => line.trim().match(/^([a-z_]+)\s+(uuid|text|jsonb|timestamptz|integer)\b/)?.[1])
      .filter(Boolean),
  );
  const view = schema.slice(schema.indexOf("create or replace view rr_lead_index"));
  const select = view.slice(0, view.indexOf("\nfrom rr_leads l"));
  for (const [, alias] of select.matchAll(/^\s*(?:activity\.|coalesce\()[^\n]*?\bas (\w+)\s*$/gm)) columns.add(alias);
  for (const [, name] of select.matchAll(/^\s*activity\.(\w+),\s*$/gm)) columns.add(name);
  return columns;
})();

test("the view really does add the two columns the sorts depend on", () => {
  // Guards the parse above as much as the schema: a regex that silently matched nothing would make
  // the next test vacuous, and it is the one holding the sorts to columns that exist.
  assert.ok(leadColumns.has("last_reply_at"));
  assert.ok(leadColumns.has("reply_count"));
});

test("every sort orders by columns that exist on rr_lead_index", () => {
  // A generated-stored column is as real as any other to `order=`, which is the whole reason the
  // rollup ones can be sorted in the database instead of across one loaded page.
  for (const sort of LEAD_SORTS) {
    for (const term of sort.order.split(",")) {
      const column = term.split(".")[0];
      assert.ok(
        leadColumns.has(column),
        `${sort.id} orders by "${column}", which is not a column on rr_lead_index`,
      );
    }
  }
});

test("the route reads the view, since the view is where two of the sort columns live", () => {
  // Sorting by `last_reply_at` against `rr_leads` is a 400 from PostgREST, so these two travel
  // together: the moment the query names the base table again, half the list stops working.
  const route = readFileSync(new URL("../app/api/database/leads/route.ts", import.meta.url), "utf8");
  assert.match(route, /`rr_lead_index\?select=\*/);
});

test("sorts on non-unique columns carry a tiebreaker so paging cannot repeat or skip a row", () => {
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

test("sorts on nullable columns put empty values last rather than first", () => {
  // A lead can reach the database before its rollup is filled in, and most leads have never replied
  // at all, so `last_reply_at` is null far more often than not. Without this, choosing "Newest reply
  // first" opens on a page of blanks, which reads as a broken table rather than as incomplete data.
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
  for (const value of ["", "   ", "last-reply", "name", null, undefined]) {
    assert.equal(leadSortOrder(value), DEFAULT_LEAD_SORT.order);
  }
});

test("the default orders by the date the table displays", () => {
  // The page shows this as the dropdown's placeholder and sends no `sort` for it, so the two sides
  // agree only as long as the API's fallback is this one. It has to be `last_reply_at`, because the
  // date column renders `lead.lastReplyAt` — a default of `created_at.desc` is precisely the bug
  // that made the first version of this control look like it did nothing.
  assert.match(DEFAULT_LEAD_SORT.order, /^last_reply_at\.desc\.nullslast/);
});

test("the sort the date column implies is the default rather than an also-offered entry", () => {
  // Two ways to say "newest first" would be one too many, and the placeholder would be a lie about
  // which of them is in effect.
  const byLastReplyDesc = LEAD_SORTS.filter((sort) => sort.order.startsWith("last_reply_at.desc"));
  assert.deepEqual(byLastReplyDesc, [DEFAULT_LEAD_SORT]);
});
