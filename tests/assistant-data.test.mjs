// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { bigListToFile, toCsv } from "../app/lib/assistant-data.ts";

const many = (n) => Array.from({ length: n }, (_, i) => ({ name: `Lead ${i}`, company: i % 2 ? "Acme, Inc" : "Globex" }));

test("a short list stays with the model and makes no file", () => {
  const { file, rest } = bigListToFile("search_leads", { leads: many(10) });
  assert.equal(file, null);
  assert.equal(rest.leads.length, 10);
});

test("a long list becomes a CSV and the model is told not to retype it", () => {
  const { file, rest } = bigListToFile("search_leads", { client: "Willow", leads: many(1000) });
  assert.ok(file && file.mime === "text/csv");
  assert.equal(file.content.split("\n").length, 1001);
  assert.equal(rest.leadsTotal, 1000);
  assert.ok(rest.leads.length <= 300);
  assert.match(rest.instruction, /Do NOT write these rows out/);
  assert.equal(rest.client, "Willow");
});

test("a top-level array works too", () => {
  const { file, rest } = bigListToFile("query_data", many(40));
  assert.ok(file);
  assert.equal(rest.totalRows, 40);
});

test("reference lists never become files", () => {
  const { file } = bigListToFile("list_clients", many(40));
  assert.equal(file, null);
});

test("CSV quotes commas and quotes", () => {
  const csv = toCsv([{ a: 'say "hi"', b: "x, y" }]);
  assert.equal(csv, 'a,b\n"say ""hi""","x, y"');
});
