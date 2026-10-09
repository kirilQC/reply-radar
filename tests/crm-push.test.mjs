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
  assert.deepEqual(own, ["qc_linkedin_url", "qc_company_linkedin_url", "qc_latest_reply", "qc_conversation", "qc_booked_meeting", "qc_campaign", "qc_sender", "qc_outreach_platform", "qc_first_reply_date", "qc_last_reply_date", "qc_reply_sentiment", "qc_reply_count"]);
  assert.match(source, /put\("qc_outreach_platform", record\.platform === "Email Bison" \? "email_bison" : record\.platform\.toLowerCase\(\)\)/);
  for (const field of ["firstname", "lastname", "email", "jobtitle", "company", "website", "domain", "linkedin_company_page"]) assert.match(source, new RegExp(`name: "${field}"`), field);
});

test("saving part of a destination patches the existing row, and re-reading asks HubSpot for the key's scopes again", () => {
  const lib = readFileSync(new URL("../app/lib/crm-push.ts", import.meta.url), "utf8");
  assert.match(lib, /rr_crm_push\?workspace_id=eq\.\$\{enc\(workspaceId\)\}&kind=eq\.\$\{enc\(kind\)\}`, \{\n    method: "PATCH"/);
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
  assert.equal((one.match(/await push\(destination\.api_key/g) ?? []).length, 1);
  assert.match(one, /\/contacts\/\$\{destination\.account_id\}\/record\/0-1\/\$\{result\.contactId\}/);
});

test("Attio: QC's data lives on a shared QC Growth list, the person keeps its own fields, nothing is deleted", () => {
  const source = readFileSync(new URL("../app/lib/attio-push.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"DELETE"/);
  assert.match(source, /workspace_access: "full-access"/);
  assert.match(source, /\/\/ The client's person: QC's match key always, their own fields only where empty, nothing else\./);
  const person = [...source.slice(source.indexOf("QC_PERSON_ATTRIBUTES"), source.indexOf("QC_LIST_ATTRIBUTES")).matchAll(/slug: "(qc_[a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(person, ["qc_linkedin_url"]);
  const run = readFileSync(new URL("../app/lib/crm-push-run.ts", import.meta.url), "utf8");
  assert.match(run, /if \(destination\.provider === "attio"\) return attioPush;/);
});

test("Google Sheets: only mapped columns and QC ID are written, a lead is found again by QC ID, the push needs a confirmed mapping", () => {
  const lib = readFileSync(new URL("../app/lib/sheets-push.ts", import.meta.url), "utf8");
  assert.match(lib, /if \(!key\) return;/);
  assert.match(lib, /const existing = rowById\.get\(item\.id\);/);
  // A meetings sheet: one row per person, QC's own tests out.
  assert.match(lib, /if \(internalMeeting\(meeting\)\) continue;/);
  assert.doesNotMatch(lib, /"DELETE"|:clear|deleteDimension/);
  const route = readFileSync(new URL("../app/api/sheets-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(route, /if \(destination\.status !== "built"\) return NextResponse\.json\(\{ ok: false, error: "Confirm the column mapping first\." \}/);
});

test("Deals: an existing deal is updated but never moved back a stage, named for the company, a canceled meeting with no deal stays out", () => {
  const hub = readFileSync(new URL("../app/lib/hubspot-deals.ts", import.meta.url), "utf8");
  const attioDeals = readFileSync(new URL("../app/lib/attio-deals.ts", import.meta.url), "utf8");
  const run = readFileSync(new URL("../app/lib/meetings-deals-run.ts", import.meta.url), "utf8");
  assert.match(hub, /PATCH", `\/crm\/v3\/objects\/deals\/\$\{enc\(dealId\)\}`, \{ properties: \{ \.\.\.qc, \.\.\.rename \} \}/);
  assert.match(hub, /name: text\(meeting\.company_name\) \|\| reply\?\.company \|\| text\(meeting\.invitee_name\)/);
  const attioUpdate = attioDeals.slice(attioDeals.indexOf("if (dealId) {"), attioDeals.indexOf("if (!dealId) {"));
  assert.doesNotMatch(attioUpdate, /stage:|owner:/);
  assert.match(run, /if \(\/cancel\/i\.test\(text\(meeting\.status\)\) && !before\?\.deal_id/);
  for (const source of [hub, attioDeals, run]) assert.doesNotMatch(source, /"DELETE"/);
});

test("Deals: names cleaned, one deal per person, QC's own test bookings skipped", () => {
  const run = readFileSync(new URL("../app/lib/meetings-deals-run.ts", import.meta.url), "utf8");
  assert.match(run, /split\(";"\)/);
  assert.match(run, /const before = own \?\? byPerson\.get\(personKey\(meeting\)\);/);
  assert.match(run, /if \(internalMeeting\(meeting\)\) \{ summary\.unchanged \+= 1; continue; \}/);
});

test("Every push path takes the per-destination lock, so the sync and a click never both create the same deal or row", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.match(read("../app/api/crm-push/sync/route.ts"), /withPushLock\(config, destination\.workspace_id, destination\.kind/);
  const crmRoute = read("../app/api/crm-push/[slug]/route.ts");
  assert.equal((crmRoute.match(/withPushLock\(c, workspace\.id, "crm"/g) ?? []).length, 2);
  assert.match(read("../app/api/sheets-push/[slug]/route.ts"), /withPushLock\(c, workspace\.id, kind/);
  assert.match(read("../app/lib/crm-sync-status.ts"), /withPushLock\(config, workspaceId, destination\.kind/);
  assert.doesNotMatch(crmRoute, /probe_calls|probe_write/);
});
