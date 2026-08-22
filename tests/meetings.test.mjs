// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeMeeting, parseWhen, meetingIsUsable } from "../shared/meetings.mjs";

test("parseWhen accepts ISO, strips a human '@', and rejects nonsense", () => {
  assert.equal(parseWhen("2026-08-19T14:00:00.000Z"), "2026-08-19T14:00:00.000Z");
  assert.equal(parseWhen("August 19, 2026 @ 10:00 AM EST").startsWith("2026-08-19"), true);
  assert.equal(parseWhen("whenever"), "");
  assert.equal(parseWhen(""), "");
});

test("normalizeMeeting pulls the client out separately and maps the common Calendly/Zapier fields", () => {
  const { client, fields } = normalizeMeeting({
    client: "Steadywell",
    Name: "Maria Tsambarlis",
    Email: "mtsambarlis24@gmail.com",
    Company: "At Home Harmony",
    Title: "Director of Clinical Operations",
    "Meeting with": "Josh & Tim",
    Campaign: "SW015: Social Signals (Batch 5)",
    start_time: "2026-08-19T14:00:00.000Z",
    Summary: "Steadywell Intro",
  });
  assert.equal(client, "Steadywell");
  assert.equal(fields.invitee_name, "Maria Tsambarlis");
  assert.equal(fields.invitee_email, "mtsambarlis24@gmail.com");
  assert.equal(fields.company_name, "At Home Harmony");
  assert.equal(fields.invitee_title, "Director of Clinical Operations");
  assert.equal(fields.host, "Josh & Tim");
  assert.equal(fields.campaign, "SW015: Social Signals (Batch 5)");
  assert.equal(fields.summary, "Steadywell Intro");
  assert.equal(fields.meeting_at, "2026-08-19T14:00:00.000Z");
  assert.equal(fields.status, "scheduled");
});

test("normalizeMeeting matches aliases case- and separator-insensitively", () => {
  const { fields } = normalizeMeeting({
    client_name: "Bluevia",
    company_name: "Acme",
    companyDomain: "acme.com",
    "Company LinkedIn": "https://linkedin.com/company/acme",
    "Lead Location": "United States",
    "Lead Headline": "VP of Ops",
    "Company Size": "201-500 employees",
  });
  assert.equal(fields.company_domain, "acme.com");
  assert.equal(fields.company_linkedin, "https://linkedin.com/company/acme");
  assert.equal(fields.invitee_location, "United States");
  assert.equal(fields.invitee_headline, "VP of Ops");
  assert.equal(fields.company_size, "201-500 employees");
});

test("normalizeMeeting reaches one level of nesting (invitee.name)", () => {
  const { fields } = normalizeMeeting({ client: "X", invitee: { name: "Dana Lee", email: "dana@x.com" } });
  assert.equal(fields.invitee_name, "Dana Lee");
  assert.equal(fields.invitee_email, "dana@x.com");
});

test("normalizeMeeting keeps an unparseable time as text and leaves meeting_at null", () => {
  const { fields } = normalizeMeeting({ client: "X", name: "A", time: "sometime next week" });
  assert.equal(fields.meeting_at, null);
  assert.equal(fields.when_text, "sometime next week");
});

test("normalizeMeeting maps cancel/reschedule statuses", () => {
  assert.equal(normalizeMeeting({ status: "invitee.canceled" }).fields.status, "canceled");
  assert.equal(normalizeMeeting({ event: "Rescheduled" }).fields.status, "rescheduled");
  assert.equal(normalizeMeeting({ status: "" }).fields.status, "scheduled");
});

test("normalizeMeeting keeps the whole payload in raw", () => {
  const payload = { client: "X", name: "A", weird_field: "kept" };
  const { fields } = normalizeMeeting(payload);
  assert.deepEqual(fields.raw, payload);
});

test("meetingIsUsable needs at least a name, email or company", () => {
  assert.equal(meetingIsUsable({ invitee_name: "A" }), true);
  assert.equal(meetingIsUsable({ invitee_email: "a@b.com" }), true);
  assert.equal(meetingIsUsable({ company_name: "Acme" }), true);
  assert.equal(meetingIsUsable({ campaign: "only a campaign" }), false);
  assert.equal(meetingIsUsable({}), false);
});
