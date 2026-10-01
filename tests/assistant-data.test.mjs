// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { bigListToDataset, exportDatasets, toCsv } from "../app/lib/assistant-data.ts";

const many = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ name: `Lead ${i + offset}`, company: i % 2 ? "Acme, Inc" : "Globex" }));

test("a short list stays with the model and makes no dataset", () => {
  const store = new Map();
  const rest = bigListToDataset("search_leads", { leads: many(10) }, store);
  assert.equal(store.size, 0);
  assert.equal(rest.leads.length, 10);
});

test("a long list becomes a dataset and the model is told not to retype it", () => {
  const store = new Map();
  const rest = bigListToDataset("search_leads", { client: "Willow", leads: many(1000) }, store);
  assert.equal(store.size, 1);
  assert.equal(rest.datasetId, "ds1");
  assert.equal(rest.leadsTotal, 1000);
  assert.ok(rest.leads.length <= 300);
  assert.match(rest.instruction, /Do NOT write these rows out/);
});

test("several lookups leave as ONE de-duplicated CSV", () => {
  const store = new Map();
  bigListToDataset("search_outreach", { people: many(40) }, store);
  bigListToDataset("search_outreach", { people: many(40, 20) }, store);
  const { file, rows } = exportDatasets(store, { datasets: ["ds1", "ds2"], dedupeBy: "name", name: "cisos contacted" });
  assert.equal(rows, 60);
  assert.equal(file.content.split("\n").length, 61);
  assert.match(file.name, /^cisos-contacted-\d{4}-\d{2}-\d{2}\.csv$/);
});

test("reference lists never become datasets", () => {
  const store = new Map();
  bigListToDataset("list_clients", many(40), store);
  assert.equal(store.size, 0);
});

test("CSV quotes commas and quotes", () => {
  assert.equal(toCsv([{ a: 'say "hi"', b: "x, y" }]), 'a,b\n"say ""hi""","x, y"');
});
