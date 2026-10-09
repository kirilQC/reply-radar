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

test("HubSpot sign-in opens on the portal's own region host, never app.hubspot.com for an na2 portal (redirect loop)", async () => {
  const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../app/lib/hubspot-user.ts", import.meta.url), "utf8"));
  const start = await import("node:fs").then((fs) => fs.readFileSync(new URL("../app/api/hubspot/oauth/start/route.ts", import.meta.url), "utf8"));
  assert.match(src, /accountHost\?: string \| null/);
  assert.match(src, /return `https:\/\/\$\{host\}\/oauth\//);
  assert.match(start, /authorizeUrl\(OAUTH_ORIGIN, slug, destination\?\.account_id, destination\?\.account_name\)/);
});

test("every action the CRM and Sheets panels send has a handler in the routes (no 'Unknown action.')", () => {
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const routes = ["../app/api/crm-push/[slug]/route.ts", "../app/api/sheets-push/[slug]/route.ts"].map((p) => readFileSync(new URL(p, import.meta.url), "utf8")).join("\n");
  const sent = [...new Set([...ui.matchAll(/step\("([a-z_]+)"/g)].map((m) => m[1]))];
  assert.ok(sent.length > 5);
  for (const action of sent) assert.ok(routes.includes(`action === "${action}"`), `no handler for "${action}"`);
});

test("HubSpot dashboard section links to the client's In beta page until a dashboard exists", () => {
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  assert.match(ui, /\/product-updates\/\$\{c\.accountId\}\/in-beta/);
  assert.match(ui, /!c\.config\?\.dashboard_id && c\.accountId/);
});

test("HubSpot reports never duplicate: build stops when it cannot read what exists, dedupes by name, one build at a time", () => {
  const src = readFileSync(new URL("../app/lib/hubspot-reporting.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /allByName[\s\S]{0,400}\.catch\(\(\) => \(\{\} as Row\)\)/, "existing-report lookup must not swallow errors");
  assert.match(src, /return \{ log, dashboardId: null, pending: waiting \}/);
  assert.match(src, /ids\.find\(\(id\) => onDashboard\.has\(id\)\) \?\? ids\[0\]/);
  assert.match(route, /withPushLock\(c, workspace\.id, "reporting"/);
});

test("client Operations page: one button on onboarding, every sign-in comes back to it, deals scopes asked for", () => {
  const onboarding = readFileSync(new URL("../app/onboarding/[slug]/page.tsx", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const hubspotBack = readFileSync(new URL("../app/api/hubspot/oauth/callback/route.ts", import.meta.url), "utf8");
  const bookings = readFileSync(new URL("../app/slack/BookingAlerts.tsx", import.meta.url), "utf8");
  assert.match(onboarding, /href=\{`\/operations\/\$\{client\.slug\}`\}/);
  assert.doesNotMatch(onboarding, /OpsCockpit/);
  assert.match(hubspotBack, /\/operations\/\$\{slug/);
  assert.match(ui, /oauth\/start\?return=\$\{encodeURIComponent\(`\/operations\/\$\{slug\}`\)\}/);
  assert.match(bookings, /`\/operations\/\$\{focus\}\?view=meetings`/);
  assert.match(ui, /"crm\.objects\.deals\.write",/);
});

test("the Booked Meeting (QC) stage is never skipped: no opt-out, a key without deals access blocks the build and says why", () => {
  const deals = readFileSync(new URL("../app/lib/hubspot-deals.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  const push = readFileSync(new URL("../app/lib/hubspot-push.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(deals, /pipelines\/deals"\)\.then\(\(data\) => list\(data\.results\)\)\.catch\(\(\) => \[\]/, "a refused pipeline read must not look like 'no pipelines'");
  assert.match(deals, /enabled: true,\n\s+blocker,/);
  assert.match(route, /if \(freshDeals\.blocker\) return NextResponse\.json\(\{ ok: false/);
  assert.match(route, /if \(!planDeals\.available\) return NextResponse\.json\(\{ ok: false/);
  for (const scope of ["crm.objects.deals.read", "crm.objects.deals.write", "crm.schemas.deals.read", "crm.schemas.deals.write"]) assert.ok(push.includes(`"${scope}"`), scope);
  assert.doesNotMatch(ui, /setPushDeals/);
  assert.match(ui, /disabled=\{Boolean\(busy\) \|\| Boolean\(dealsBlocker\) \|\| scopeBlocked\}/);
});

test("the HubSpot connect steps list every scope QC Command checks for, one exact name per bullet", async () => {
  const push = readFileSync(new URL("../app/lib/hubspot-push.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const listOf = (src, marker) => [...src.slice(src.indexOf(marker), src.indexOf("];", src.indexOf(marker))).matchAll(/"([a-z.]+)"/g)].map((m) => m[1]);
  const required = listOf(push, "export const REQUIRED_SCOPES");
  const shown = listOf(ui, "const HUBSPOT_SCOPES");
  assert.ok(required.length >= 17);
  assert.deepEqual([...shown].sort(), [...required].sort());
  assert.doesNotMatch(ui, /\.read \+ write/);
});

test("a key short any scope stops every build: scopes re-read live, build refused naming each one, buttons locked", () => {
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const deals = readFileSync(new URL("../app/lib/hubspot-deals.ts", import.meta.url), "utf8");
  for (const action of ["apply\" && destination.provider === \"attio", "apply", "reporting"]) {
    const at = route.indexOf(`if (action === "${action}") {`);
    assert.ok(at > 0, action);
    assert.match(route.slice(at, at + 200), /const blocked = await scopeGate\(\);\s+if \(blocked\) return blocked;/, `${action} is not gated`);
  }
  assert.match(route, /REQUIRED_SCOPES\.filter\(\(scope\) => !scopes\.includes\(scope\)\)/);
  assert.match(route, /Nothing was built\. The key is missing/);
  for (const button of ["step(\"apply\"", "step(\"reporting\")", "step(\"push_one\")", "pushAll()"]) {
    const at = ui.indexOf(button);
    assert.ok(ui.slice(Math.max(0, at - 200), at).includes("scopeBlocked"), `${button} not locked by missing scopes`);
  }
  assert.match(deals, /export async function ensureStageFirst/);
});

test("Operations: the CRM a client doesn't use is locked, the pulse shows QC's share and raises alerts", () => {
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(ui, /disabled=\{Boolean\(locked\)\}/);
  assert.match(ui, /crm\.provider !== view\) setView/);
  assert.match(ui, /replies and deals are flowing into/);
  assert.match(ui, /Ours \(from QC\)/);
  assert.match(route, /propertyName: "qc_outreach_platform", operator: "HAS_PROPERTY"/);
});

test("tables (Google Sheets and Airtable) hold replies, booked meetings or campaigns through one writer", () => {
  const sheets = readFileSync(new URL("../app/lib/sheets-push.ts", import.meta.url), "utf8");
  const table = readFileSync(new URL("../app/lib/table-push.ts", import.meta.url), "utf8");
  const run = readFileSync(new URL("../app/lib/crm-push-run.ts", import.meta.url), "utf8");
  const sync = readFileSync(new URL("../app/api/crm-push/sync/route.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  assert.match(sheets, /export type SheetContent = "replies" \| "meetings" \| "campaigns"/);
  // Campaigns: added on launch, written again on a status change and weekly, every one on Push all.
  assert.match(sheets, /const due = opts\.all \|\| !before \|\| before\.status !== status \|\| Date\.now\(\) - Date\.parse\(before\.at\) >= WEEK/);
  assert.match(sheets, /if \(!isLaunched\(campaign\)\) continue;/);
  assert.match(table, /if \(destination\.provider === "airtable"\) return airtableWriteRows/);
  assert.match(table, /campaign_state: state/);
  assert.match(run, /if \(isTable\(destination\) && tableContent\(destination\) !== "replies"\) return summary;/);
  assert.match(run, /if \(destination\.provider === "airtable"\) return `airtable:\$\{destination\.kind\.slice\("airtable:"\.length\)\}`;/);
  assert.match(sync, /isTable\(destination\)\s*\? await tableItemsPass/);
  assert.match(ui, /\["replies", "meetings", "campaigns"\] as const/);
  assert.match(ui, /const VIEWS: View\[\] = \["hubspot", "attio", "sheets", "airtable", "meetings"\]/);
});

test("Airtable push finds records again by a QC ID field, writes by field id and never touches computed fields", () => {
  const airtable = readFileSync(new URL("../app/lib/airtable-push.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/airtable-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(airtable, /export const AIRTABLE_QC_ID = "QC ID"/);
  assert.match(airtable, /const updates = items\.filter\(\(item\) => recordById\.has\(item\.id\)\)/);
  assert.match(airtable, /typecast: true/);
  assert.doesNotMatch(airtable, /"formula"|"multipleLookupValues"|"autoNumber"/);
  assert.match(airtable, /await pause\(220\)/);
  for (const action of ["connect", "reread", "content", "map", "push", "auto", "disconnect"]) assert.ok(route.includes(`action === "${action}"`), action);
  assert.match(route, /withPushLock\(c, workspace\.id, kind/);
});

test("Airtable picks the client's base (saved one first, then the name) and the table that fits the content", async () => {
  const src = readFileSync(new URL("../app/lib/airtable-push.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("const squash"), src.indexOf("// ── Making tables"));
  const js = body.replace(/: Array<\{ id: string; name: string \}>/g, "").replace(/: \{ id: string; why: string \} \| null/g, "").replace(/: Record<SheetContent, RegExp>/g, "").replace(/, content: SheetContent\): string/g, ", content)").replace(/clientName: string, savedId: string\)/g, "clientName, savedId)").replace(/\(value: string\)/g, "(value)").replace(/export /g, "");
  const { suggestBase, suggestTable } = new Function(`${js}; return { suggestBase, suggestTable };`)();
  const bases = [{ id: "app1", name: "Hyperpath" }, { id: "app2", name: "Camb" }, { id: "app3", name: "Camb" }, { id: "app4", name: "Bluevia Health" }, { id: "app5", name: "KI test" }];
  assert.equal(suggestBase(bases, "Hyperpath", "").id, "app1");
  assert.equal(suggestBase(bases, "Camb", "app3").id, "app3");
  assert.equal(suggestBase(bases, "Bluevia", "").id, "app4");
  assert.equal(suggestBase(bases, "Nobody", ""), null);
  const tables = [{ id: "t1", name: "Leads" }, { id: "t2", name: "Campaign tracker" }, { id: "t3", name: "Booked calls" }];
  assert.equal(suggestTable(tables, "campaigns"), "t2");
  assert.equal(suggestTable(tables, "meetings"), "t3");
  assert.equal(suggestTable(tables, "replies"), "t1");
  assert.equal(suggestTable([{ id: "x", name: "Table 1" }], "campaigns"), "x");
  // No clear fit in a base with several tables: left to the person, never a guess like the onboarding table.
  assert.equal(suggestTable([{ id: "o", name: "Onboarding Responses" }, { id: "p", name: "Tasks" }], "replies"), "");
});

test("crm_sync_status counts an Airtable table's mapped fields (mapping by field id, not position)", () => {
  const src = readFileSync(new URL("../app/lib/crm-sync-status.ts", import.meta.url), "utf8");
  assert.match(src, /: Object\.values\(object\(sheetConfig\.mapping\)\)\.filter\(Boolean\)\.length/);
});

test("a built CRM shows three boxes (replies, booked meetings, dashboard) with the last person added", () => {
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/crm-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(ui, /className="ops-trio"/);
  assert.equal((ui.match(/className="ops-panel ops-box"/g) ?? []).length, 4);
  assert.match(ui, /label="Last person added"/);
  assert.match(ui, /label="Last booked meeting added"/);
  assert.match(route, /created_contact=is\.true&error=is\.null&order=pushed_at\.desc&limit=1/);
  assert.match(route, /deal_id=not\.is\.null&error=is\.null&order=pushed_at\.desc&limit=1/);
});

test("tables get their standard columns: Airtable can create the table, and missing columns are added to sheets and tables", () => {
  const sheets = readFileSync(new URL("../app/lib/sheets-push.ts", import.meta.url), "utf8");
  const airtable = readFileSync(new URL("../app/lib/airtable-push.ts", import.meta.url), "utf8");
  const sheetRoute = readFileSync(new URL("../app/api/sheets-push/[slug]/route.ts", import.meta.url), "utf8");
  const atRoute = readFileSync(new URL("../app/api/airtable-push/[slug]/route.ts", import.meta.url), "utf8");
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  // Every standard key exists in its catalog.
  const block = sheets.slice(sheets.indexOf("export const STANDARD_FIELDS"), sheets.indexOf("};", sheets.indexOf("export const STANDARD_FIELDS")));
  for (const [content, keys] of [...block.matchAll(/(replies|meetings|campaigns): \[([^\]]+)\]/g)].map((m) => [m[1], [...m[2].matchAll(/"([a-z_]+)"/g)].map((k) => k[1])])) {
    const catalog = content === "meetings" ? "MEETING_SHEET_FIELDS" : content === "campaigns" ? "CAMPAIGN_FIELDS" : "SHEET_FIELDS";
    const defs = sheets.slice(sheets.indexOf(`export const ${catalog}`));
    for (const key of keys) assert.ok(defs.includes(`key: "${key}"`), `${content}: ${key} not in ${catalog}`);
  }
  assert.match(sheetRoute, /addMissingSheetColumns\(sheet\.spreadsheetId, sheet\.tab, sheet\.headers, mapping, content\)/);
  assert.doesNotMatch(sheetRoute, /Add your headers in row 1 of the sheet first/);
  assert.match(atRoute, /action === "create"/);
  assert.match(atRoute, /addMissingAirtableFields\(baseId, tableId/);
  assert.match(airtable, /if \(taken\.has\(String\(spec\.name\)\.toLowerCase\(\)\)\) continue;/);
  assert.match(ui, /Create the table for me/);
});

test("booked meetings on Operations: six numbered steps, everything saves itself, QC writes the About from the brain, the site and the web", () => {
  const ui = readFileSync(new URL("../app/components/BookingSetup.tsx", import.meta.url), "utf8");
  const ops = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const about = readFileSync(new URL("../app/api/bookings/about/route.ts", import.meta.url), "utf8");
  assert.equal((ui.match(/<StepCard n=\{\d\}/g) ?? []).length, 6);
  assert.doesNotMatch(ui, />Save</, "no Save buttons: every field saves itself");
  assert.match(ui, /Write it for me/);
  assert.match(ui, /briefAboutSources: result\.payload\.sources/);
  assert.match(ui, /The old HubSpot deal step is still on/);
  assert.match(ops, /<BookingSetup slug=\{slug\}/);
  assert.match(about, /brainContext\(/);
  assert.match(about, /siteText\(text\(workspace\.website_url\)\)/);
  assert.match(about, /web_search_20250305/);
  assert.match(about, /thinking: \{ type: "between_tools" \}/);
  assert.match(about, /const undash/);
  // The answer only: nothing from before the last search, and cited pieces joined without breaks.
  assert.match(about, /blocks\.slice\(lastTool \+ 1\)/);
  assert.match(about, /\.join\(""\)/);
});

test("a confirmed sheet or Airtable table holds one thing for good: no content switch, and the server refuses a change", () => {
  const ui = readFileSync(new URL("../app/components/ClientOperations.tsx", import.meta.url), "utf8");
  const at = readFileSync(new URL("../app/api/airtable-push/[slug]/route.ts", import.meta.url), "utf8");
  const sh = readFileSync(new URL("../app/api/sheets-push/[slug]/route.ts", import.meta.url), "utf8");
  assert.match(ui, /\{built\s*\? <span className="bk-chip bk-chip-on ops-holds">Holds/);
  assert.match(at, /if \(destination\.status === "built" && contentOf\(body\.content\) !== content\) return NextResponse\.json\(\{ ok: false/);
  assert.match(sh, /if \(destination\.status === "built" && contentValue\(body\.content\) !== contentOf\(destination\)\) return NextResponse\.json\(\{ ok: false/);
});

test("Send a test: the person types name, email, company and title, and the row goes to Clay with the client's name", async () => {
  const ui = readFileSync(new URL("../app/components/BookingSetup.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/bookings/test/route.ts", import.meta.url), "utf8");
  const run = readFileSync(new URL("../app/lib/booking-run.ts", import.meta.url), "utf8");
  for (const label of ["Name", "Email", "Company name", "Job title"]) assert.ok(ui.includes(`ops-field">${label}<input`), label);
  assert.match(ui, /JSON\.stringify\(\{ clay: true, workspaceId: client\.id, lead \}\)/);
  assert.match(route, /rr_workspaces\?select=name,slug&id=eq\./);
  assert.match(run, /lead\?\.client \?\? \{ name: "QC Command test", slug: "test" \}/);
  const { clayRow } = await import("../shared/bookings.mjs");
  const row = clayRow({ id: "test", invitee_name: "Ada Lovelace", invitee_email: "ada@example.com", company_name: "Analytical", invitee_title: "CTO" }, { name: "Chroma", slug: "chroma" }, "https://cb", true);
  assert.equal(row.Client, "Chroma");
  assert.equal(row.Name, "Ada Lovelace");
  assert.equal(row.Email, "ada@example.com");
  assert.equal(row["USER company name"], "Analytical");
  assert.equal(row["USER title"], "CTO");
  assert.equal(row.test, true);
});

test("Clay's answer: lead name and email accepted (never over what the booking form had), photo and logo from AI Ark by LinkedIn", async () => {
  const { fromClay } = await import("../shared/bookings.mjs");
  const parsed = fromClay({ meeting_id: "m1", test: "false", lead_name: "Ada Lovelace", lead_email: "ada@analytical.com", client: "Chroma", date: "Oct 12", lead_linkedin: "linkedin.com/in/ada" });
  assert.equal(parsed.meetingId, "m1");
  assert.equal(parsed.fields.invitee_name, "Ada Lovelace");
  assert.equal(parsed.fields.invitee_email, "ada@analytical.com");
  assert.equal(fromClay({ meeting_id: "m2", company_name: "Acme" }).fields.invitee_name, "");
  const run = readFileSync(new URL("../app/lib/booking-run.ts", import.meta.url), "utf8");
  assert.match(run, /const FORM_COLUMNS = new Set\(\["invitee_title", "company_name", "invitee_name", "invitee_email"\]\)/);
  assert.match(run, /photosFromAiArk\(linkedin,/);
  assert.match(run, /if \(pictures\?\.photo && !clean\(meeting\.invitee_photo_url\)\)/);
});

test("a test lead carries on after Clay: brief and Slack post to the test channel, nothing stored, no deal", () => {
  const run = readFileSync(new URL("../app/lib/booking-run.ts", import.meta.url), "utf8");
  assert.match(run, /id: lead\?\.client\.id \? `test:\$\{lead\.client\.id\}` : "test"/);
  assert.match(run, /run: \(\) => runTestLead\(config, workspaceId, parsed\.fields\)/);
  assert.match(run, /deliverBooking\(config, "test", \{ test: true, channel, meeting \}\)/);
  // A test only ever runs the Slack step, to the test channel, and saves nothing.
  assert.match(run, /settings\.steps\.filter\(\(step\) => step\.enabled && \(!test \|\| step\.type === "slack"\)\)/);
  assert.match(run, /let meeting = test && opts\.meeting \? opts\.meeting : await loadMeeting/);
});

test("booked meetings: campaign attribution after enrichment (QC leads, then HeyReach by LinkedIn and email), Slack posts expanded, typed test values win", async () => {
  const run = readFileSync(new URL("../app/lib/booking-run.ts", import.meta.url), "utf8");
  assert.match(run, /export async function attributeCampaign\(/);
  assert.match(run, /if \(linkedin\) lookups\.push\(\{ profileUrl: linkedin \}\);/);
  assert.match(run, /if \(email\.includes\("@"\)\) lookups\.push\(\{ email \}\);/);
  assert.match(run, /items\.find\(\(item\) => isOurCampaign\(item\.name\)\) \?\? items\[0\]/);
  // Runs for every booking with no campaign yet, Clay or not, tests included (tests save nothing).
  assert.match(run, /if \(!clean\(meeting\.campaign\)\) \{\s*const attributed = await attributeCampaign\(config, workspace, meeting\)/);
  assert.match(run, /\.\.\.form,\s*\};/);
  const { bookingBlocks } = await import("../shared/bookings.mjs").catch(() => ({}));
  const src = readFileSync(new URL("../shared/bookings.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/type: "section", expand: true/g) ?? []).length, 2);
});

test("the booking card says which meeting with the person it is (canceled ones don't count) and whether it was rescheduled", async () => {
  const { buildBookingCard, meetingNumberAmong, meetingOrdinal } = await import("../shared/bookings.mjs");
  const others = [
    { id: "a", created_at: "2026-09-01", status: "scheduled", invitee_email: "d@sbmf.org", invitee_name: "Derrick Forchetti" },
    { id: "b", created_at: "2026-09-10", status: "canceled", invitee_email: "d@sbmf.org" },
    { id: "c", created_at: "2026-09-20", status: "scheduled", invitee_name: "Derrick Forchetti" },
    { id: "x", created_at: "2026-09-05", status: "scheduled", invitee_email: "o@x.com", invitee_name: "Other Person" },
  ];
  assert.equal(meetingNumberAmong(others[0], others), 1);
  assert.equal(meetingNumberAmong({ id: "d", created_at: "2026-10-01", invitee_name: "Derrick Forchetti" }, others), 3);
  assert.equal(meetingNumberAmong({ id: "n", created_at: "2026-10-02", invitee_name: "New Lead" }, others), 1);
  assert.equal(meetingOrdinal(2), "second");
  assert.equal(meetingOrdinal(12), "12th");
  const card = buildBookingCard({ invitee_name: "Derrick Forchetti", status: "rescheduled" }, { meetingNumber: 2, rescheduledFrom: "Oct 10" });
  assert.match(card.blocks[0].text.text, /\*Meeting #2\* · second meeting with this lead · rescheduled/);
  assert.match(buildBookingCard({ invitee_name: "A B" }, { meetingNumber: 1 }).blocks[0].text.text, /^\*A new booking has been scheduled!\*\n\*Meeting #1\* · first meeting with this lead/);
});
