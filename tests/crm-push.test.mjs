// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conversationText, linkedinKey } from "../shared/crm-push-text.mjs";

test("every form of the same LinkedIn profile gives one key, so the CRM never gets two contacts", () => {
  for (const url of ["https://www.linkedin.com/in/Jane-Doe-12/", "http://linkedin.com/in/jane-doe-12?utm=x", "https://uk.linkedin.com/in/jane-doe-12", "linkedin.com/in/Jane%2DDoe%2D12"]) {
    assert.equal(linkedinKey(url), "jane-doe-12", url);
  }
  assert.equal(linkedinKey(""), "");
});

test("the conversation note is labelled QC Growth, carries campaign and sender, and keeps the newest messages when too long", () => {
  const record = { channel: "linkedin", campaign: "EM033: WHIS Partner", sender: "Amanda Ducach", messages: [
    { author: "Amanda Ducach", body: "Hi John <b>", sentAt: "2026-10-08T15:00:00Z" },
    { author: "John Martignetti", body: "Looking forward to the session.", sentAt: "2026-10-08T20:46:00Z" },
  ] };
  const html = conversationText(record, 60000, "html");
  assert.match(html, /LinkedIn conversation · QC Growth/);
  assert.match(html, /Campaign: EM033: WHIS Partner · Sender: Amanda Ducach/);
  assert.match(html, /Hi John &lt;b&gt;/, "lead text is escaped");
  const short = conversationText(record, 260, "html");
  assert.match(short, /Looking forward to the session/);
  assert.doesNotMatch(short, /Hi John/, "the oldest message gives way first");
});

test("the HubSpot build only creates; it never deletes, and only patches the lead source options it adds to", () => {
  const source = readFileSync(new URL("../app/lib/hubspot-push.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"DELETE"/);
  const patches = [...source.matchAll(/hubspot\(token, "PATCH", `([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(patches.sort(), ["/crm/v3/objects/contacts/${encodeURIComponent(contactId)}", "/crm/v3/objects/contacts/${encodeURIComponent(contactId)}", "/crm/v3/objects/notes/${encodeURIComponent(noteId)}", "/crm/v3/properties/contacts/${encodeURIComponent(item.property!)}"].sort());
  // A contact the client already had never gets lifecycle, owner or lead source from us.
  assert.match(source, /\/\/ The client's contact: QC's fields always, their basics only where empty, nothing else\.\n    const current/);
});

test("a portal already linked to another client is refused, and writes need the approved build", () => {
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(route, /already connected to another client/);
  const run = readFileSync(new URL("../app/lib/crm-push-run.ts", import.meta.url), "utf8");
  assert.match(run, /if \(destination\.status !== "built"\) throw/);
});
