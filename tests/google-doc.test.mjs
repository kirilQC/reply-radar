// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDocId,
  flattenDocTabs,
  tabBodyToMarkdown,
  messagingTabSlug,
  messagingDocPath,
  messagingTabBrainDoc,
  unsyncedTabs,
} from "../shared/google-doc.mjs";

test("parseDocId pulls the id from a pasted tab URL and ignores the ?tab fragment", () => {
  const url = "https://docs.google.com/document/d/1trOjYIqnZmti-WjcaeBL-FdIQX7ZxLSrSDuEfLQ7GQI/edit?tab=t.6aqo2zipcjrt";
  assert.equal(parseDocId(url), "1trOjYIqnZmti-WjcaeBL-FdIQX7ZxLSrSDuEfLQ7GQI");
});

test("parseDocId accepts a bare id and rejects a non-doc string", () => {
  assert.equal(parseDocId("1trOjYIqnZmti-WjcaeBL-FdIQX7ZxLSrSDuEfLQ7GQI"), "1trOjYIqnZmti-WjcaeBL-FdIQX7ZxLSrSDuEfLQ7GQI");
  assert.equal(parseDocId("https://example.com/not-a-doc"), "");
  assert.equal(parseDocId(""), "");
});

test("tabBodyToMarkdown renders headings, bullets and bold/italic runs", () => {
  const content = [
    { paragraph: { paragraphStyle: { namedStyleType: "HEADING_1" }, elements: [{ textRun: { content: "Opener\n" } }] } },
    { paragraph: { elements: [{ textRun: { content: "Hi " } }, { textRun: { content: "there", textStyle: { bold: true } } }, { textRun: { content: "\n" } }] } },
    { paragraph: { bullet: { nestingLevel: 0 }, elements: [{ textRun: { content: "first point\n" } }] } },
    { paragraph: { bullet: { nestingLevel: 1 }, elements: [{ textRun: { content: "nested\n" } }] } },
    { paragraph: { elements: [{ textRun: { content: "closing ", textStyle: { italic: true } } }] } },
  ];
  const markdown = tabBodyToMarkdown(content);
  assert.match(markdown, /^# Opener$/m);
  assert.match(markdown, /^Hi \*\*there\*\*$/m);
  assert.match(markdown, /^- first point$/m);
  assert.match(markdown, /^ {2}- nested$/m);
  assert.match(markdown, /_closing_/);
});

test("tabBodyToMarkdown flattens a table into pipe rows", () => {
  const cell = (text) => ({ content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] });
  const content = [
    { table: { tableRows: [{ tableCells: [cell("Subject"), cell("Body")] }, { tableCells: [cell("Hello"), cell("World")] }] } },
  ];
  const markdown = tabBodyToMarkdown(content);
  assert.match(markdown, /^\| Subject \| Body \|$/m);
  assert.match(markdown, /^\| Hello \| World \|$/m);
});

test("flattenDocTabs walks childTabs depth-first and skips id-less tabs", () => {
  const tabs = [
    {
      tabProperties: { tabId: "t.parent", title: "Parent" },
      documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: "parent body\n" } }] } }] } },
      childTabs: [
        { tabProperties: { tabId: "t.child", title: "Child" }, documentTab: { body: { content: [] } } },
        { tabProperties: { title: "No id" }, documentTab: { body: { content: [] } } },
      ],
    },
  ];
  const flat = flattenDocTabs(tabs);
  assert.deepEqual(flat.map((tab) => tab.tabId), ["t.parent", "t.child"]);
  assert.equal(flat[0].title, "Parent");
  assert.match(flat[0].markdown, /parent body/);
});

test("messagingTabSlug and messagingDocPath produce an idempotent brain path", () => {
  assert.equal(messagingTabSlug("Connection Request: v2"), "connection-request-v2");
  assert.equal(messagingTabSlug(""), "tab");
  assert.equal(messagingDocPath("Webrix", "Connection Request"), "clients/Webrix/Campaign messaging/connection-request.md");
});

test("messagingTabBrainDoc writes frontmatter with the tab id and the synced date", () => {
  const { path, text } = messagingTabBrainDoc(
    "Webrix",
    { tabId: "t.6aqo2zipcjrt", title: "Follow up 1", markdown: "Body line" },
    { syncedAt: new Date("2026-08-20T00:00:00Z") },
  );
  assert.equal(path, "clients/Webrix/Campaign messaging/follow-up-1.md");
  assert.match(text, /^title: Follow up 1$/m);
  assert.match(text, /^tab_id: t\.6aqo2zipcjrt$/m);
  assert.match(text, /^last_synced: 2026-08-20$/m);
  assert.match(text, /^# Follow up 1$/m);
  assert.match(text, /^Body line$/m);
});

test("messagingTabBrainDoc marks an empty tab rather than writing a blank file", () => {
  const { text } = messagingTabBrainDoc("Webrix", { tabId: "t.x", title: "Empty", markdown: "   " });
  assert.match(text, /_This tab is empty in the source document\._/);
});

test("unsyncedTabs returns only tabs whose id has not been filed", () => {
  const tabs = [
    { tabId: "t.a", title: "A", markdown: "" },
    { tabId: "t.b", title: "B", markdown: "" },
    { tabId: "t.c", title: "C", markdown: "" },
  ];
  const pending = unsyncedTabs(tabs, ["t.a", "t.c"]);
  assert.deepEqual(pending.map((tab) => tab.tabId), ["t.b"]);
  assert.deepEqual(unsyncedTabs(tabs, []).map((tab) => tab.tabId), ["t.a", "t.b", "t.c"]);
});
