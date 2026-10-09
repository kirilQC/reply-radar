// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalLinkedin, conversationText, linkedinKey } from "../shared/crm-push-text.mjs";

test("every form of the same LinkedIn profile gives one key, so the CRM never gets two contacts", () => {
  for (const url of ["https://www.linkedin.com/in/Jane-Doe-12/", "http://linkedin.com/in/jane-doe-12?utm=x", "https://uk.linkedin.com/in/jane-doe-12", "linkedin.com/in/Jane%2DDoe%2D12"]) {
    assert.equal(linkedinKey(url), "jane-doe-12", url);
  }
  assert.equal(linkedinKey(""), "");
  assert.equal(canonicalLinkedin("http://uk.linkedin.com/in/Jane-Doe-12/?x=1"), "https://www.linkedin.com/in/jane-doe-12");
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
  // The only view it edits is QC's own (found by name "QC Growth"), to keep its columns current.
  assert.deepEqual(patches.sort(), ["${QC_VIEW_PATH}/${view.id}", "/crm/v3/objects/companies/${encodeURIComponent(companyId)}", "/crm/v3/objects/contacts/${encodeURIComponent(contactId)}", "/crm/v3/objects/contacts/${encodeURIComponent(contactId)}", "/crm/v3/objects/contacts/${encodeURIComponent(contactId)}", "/crm/v3/objects/notes/${encodeURIComponent(noteId)}", "/crm/v3/properties/contacts/${encodeURIComponent(item.property!)}"].sort());
  // A contact the client already had never gets lifecycle, owner or lead source from us.
  assert.match(source, /\/\/ The client's contact: QC's fields always, their basics only where empty, nothing else\.\n    const current/);
});

test("a portal already linked to another client is refused, and writes need the approved build", () => {
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(route, /already connected to another client/);
  const run = readFileSync(new URL("../app/lib/crm-push-run.ts", import.meta.url), "utf8");
  assert.match(run, /if \(destination\.status !== "built"\) throw/);
});

test("the plan keeps QC's own fields to the minimum and maps the rest onto HubSpot's standard fields", () => {
  const source = readFileSync(new URL("../app/lib/hubspot-push.ts", import.meta.url), "utf8");
  const own = [...source.slice(source.indexOf("export const QC_PROPERTIES"), source.indexOf("/** Attribution when")).matchAll(/name: "(qc_[a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(own, ["qc_linkedin_url", "qc_company_linkedin_url", "qc_campaign", "qc_sender", "qc_outreach_platform", "qc_first_reply_date", "qc_last_reply_date", "qc_reply_sentiment", "qc_reply_count"]);
  assert.match(source, /put\("qc_outreach_platform", record\.platform === "Email Bison" \? "email_bison" : record\.platform\.toLowerCase\(\)\)/);
  for (const field of ["firstname", "lastname", "email", "jobtitle", "company", "website", "domain", "linkedin_company_page"]) assert.match(source, new RegExp(`name: "${field}"`), field);
});

test("saving part of a destination patches the existing row, and re-reading asks HubSpot for the key's scopes again", () => {
  const lib = readFileSync(new URL("../app/lib/crm-push.ts", import.meta.url), "utf8");
  assert.match(lib, /rr_crm_push\?workspace_id=eq\.\$\{enc\(workspaceId\)\}&kind=eq\.\$\{kind\}`, \{\n    method: "PATCH"/);
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(action === "replan"\) \{[\s\S]{0,200}const account = await hubspotConnect\(destination\.api_key\);/);
});

test("QC Growth owns every contact QC brings in: found or created, the default, never unassigned by an empty choice", () => {
  const source = readFileSync(new URL("../app/lib/hubspot-push.ts", import.meta.url), "utf8");
  assert.match(source, /lifecycleOnCreate: lifecycle, ownerId: qcOwner\?\.id \?\? null \}/);
  assert.match(source, /"\/settings\/v3\/users", \{ email: QC_OWNER_EMAIL, firstName: "QC", lastName: "Growth"/);
  assert.match(source, /if \(settings\.ownerId && !text\(current\.hubspot_owner_id\)\) fill\.hubspot_owner_id = settings\.ownerId;/);
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(route, /\.\.\.\(text\(choices\.ownerId\) \? \{ ownerId: text\(choices\.ownerId\) \} : \{\}\)/);
});

test("a one-lead test push sends exactly one reply and links to the contact", () => {
  const run = readFileSync(new URL("../app/lib/crm-push-run.ts", import.meta.url), "utf8");
  const one = run.slice(run.indexOf("export async function pushOne"));
  assert.equal((one.match(/hubspotPush\(/g) ?? []).length, 1);
  assert.match(one, /\/contacts\/\$\{destination\.account_id\}\/record\/0-1\/\$\{result\.contactId\}/);
});
