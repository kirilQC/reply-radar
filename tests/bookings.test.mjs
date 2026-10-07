// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import {
  answersToFields,
  buildBookingCard,
  buildInfoThread,
  buildTldrThread,
  clayRow,
  formatMeetingTime,
  fromClay,
  hostsLabel,
  linkedinUrl,
  normalizeSteps,
  parseCalCom,
  parseCalendly,
  routeBooking,
} from "../shared/bookings.mjs";

const calendlyCreated = {
  event: "invitee.created",
  created_at: "2026-08-31T20:18:00.000Z",
  payload: {
    uri: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
    name: "Jason Michael Borycki",
    email: "jason.m.borycki@gmail.com",
    rescheduled: false,
    old_invitee: null,
    questions_and_answers: [
      { question: "What is your job title?", answer: "Senior Director Analytics", position: 0 },
      { question: "Company name", answer: "Sound Physicians", position: 1 },
    ],
    scheduled_event: {
      uri: "https://api.calendly.com/scheduled_events/EV1",
      name: "Steadywell Intro",
      start_time: "2026-09-02T18:00:00.000000Z",
      event_memberships: [
        { user_email: "josh.kermisch@getsteadywell.com", user_name: "Josh Kermisch" },
        { user_email: "tim.raderstorf@getsteadywell.com", user_name: "Tim Raderstorf" },
        { user_email: "kori@qcgrowth.com", user_name: "Kori" },
      ],
    },
  },
};

test("a Calendly booking reads into the meeting columns, with title and company from the form", () => {
  const parsed = parseCalendly(calendlyCreated);
  assert.equal(parsed.kind, "created");
  assert.equal(parsed.eventName, "Steadywell Intro");
  assert.equal(parsed.externalId, "https://api.calendly.com/scheduled_events/EV1/invitees/INV1");
  assert.equal(parsed.previousId, "");
  assert.equal(parsed.fields.invitee_name, "Jason Michael Borycki");
  assert.equal(parsed.fields.invitee_title, "Senior Director Analytics");
  assert.equal(parsed.fields.company_name, "Sound Physicians");
  assert.equal(parsed.fields.company_domain, "", "a gmail address says nothing about the company");
  assert.equal(parsed.fields.host, "Josh & Tim", "our own team is left out, as on the Zap cards");
  assert.equal(parsed.fields.when_text, "September 02, 2026 @ 2:00 PM EDT");
});

test("a Calendly reschedule moves the old booking; its paired cancel is ignored", () => {
  const moved = parseCalendly({ ...calendlyCreated, payload: { ...calendlyCreated.payload, uri: "INV2", old_invitee: "INV1" } });
  assert.equal(moved.kind, "created");
  assert.equal(moved.previousId, "INV1");
  assert.equal(parseCalendly({ event: "invitee.canceled", payload: { ...calendlyCreated.payload, rescheduled: true } }).kind, "ignored");
  assert.equal(parseCalendly({ event: "invitee.canceled", payload: { ...calendlyCreated.payload, rescheduled: false } }).kind, "canceled");
});

test("a cal.com booking reads into the same shape", () => {
  const parsed = parseCalCom({
    triggerEvent: "BOOKING_CREATED",
    payload: {
      uid: "abc",
      eventTitle: "Arcjet Intro",
      title: "Arcjet Intro between Ana and Dee",
      startTime: "2026-10-10T15:00:00Z",
      organizer: { name: "Dee Ops", email: "dee@arcjet.com" },
      attendees: [{ name: "Ana Pei", email: "ana@acme.io" }],
      responses: { name: { label: "Your name", value: "Ana Pei" }, role: { label: "Your role", value: "CTO" }, org: { label: "Company", value: "Acme" } },
    },
  });
  assert.equal(parsed.kind, "created");
  assert.match(parsed.eventName, /Arcjet Intro/);
  assert.equal(parsed.fields.invitee_title, "CTO");
  assert.equal(parsed.fields.company_name, "Acme");
  assert.equal(parsed.fields.company_domain, "acme.io");
  assert.equal(parsed.fields.host, "Dee");
  assert.equal(parseCalCom({ triggerEvent: "BOOKING_RESCHEDULED", payload: { uid: "new", rescheduleUid: "abc" } }).previousId, "abc");
});

test("form answers are read by wording, and a long answer is not a company", () => {
  const fields = answersToFields([
    { question: "What does your company do?", answer: "We run a national multi-specialty medical group across forty-five states and more." },
    { question: "LinkedIn profile", answer: "linkedin.com/in/ana-pei?utm=x" },
  ]);
  assert.equal(fields.company, "");
  assert.equal(fields.linkedin, "https://linkedin.com/in/ana-pei");
});

test("routing picks the most specific event filter and refuses a tie", () => {
  const clients = [
    { id: "1", name: "Ema" },
    { id: "2", name: "Ema Health" },
    { id: "3", name: "Steadywell" },
    { id: "4", name: "Roark", filter: "roark, rk demo" },
  ];
  assert.equal(routeBooking("Ema Health Intro", clients)?.id, "2");
  assert.equal(routeBooking("Steadywell Intro", clients)?.id, "3");
  assert.equal(routeBooking("RK Demo call", clients)?.id, "4");
  assert.equal(routeBooking("Discovery call", clients), null);
  assert.equal(routeBooking("Joint call", [{ id: "a", name: "x", filter: "joint" }, { id: "b", name: "y", filter: "joint" }]), null);
});

test("Clay's answer is read by column name, LinkedIn cleaned, empty words dropped", () => {
  const parsed = fromClay({
    meeting_id: "9b2f6a8e-0000-4000-8000-000000000001",
    "Lead Linkedin": "THIS-ONEhttps://www.linkedin.com/in/michael-m-452bb614/",
    "Lead Location": "Boston, Massachusetts, United States",
    "Lead Headline": "SVP, Preferred Networks, ACO Operations",
    "Company Domain": "https://pearlhealth.com/",
    "Company Headcount": "195",
    "Company HQ": "New York, NY",
    "Company Type": "null",
    "Lead Summary": "Mike runs preferred networks.",
    "Lead Call Focus": "- Lead with network performance\n- Ask about ACO REACH",
  });
  assert.equal(parsed.meetingId, "9b2f6a8e-0000-4000-8000-000000000001");
  assert.equal(parsed.fields.invitee_linkedin, "https://www.linkedin.com/in/michael-m-452bb614");
  assert.equal(parsed.fields.company_domain, "pearlhealth.com");
  assert.equal(parsed.fields.company_size, "195 employees");
  assert.equal(parsed.fields.company_location, "New York, NY");
  assert.equal(parsed.fields.company_type, "");
  assert.equal(parsed.tldr.leadSummary, "Mike runs preferred networks.");
  assert.equal(fromClay({ meeting_id: "x", test: true }).test, true);
});

const meeting = {
  id: "m1",
  invitee_name: "Jason Michael Borycki",
  invitee_email: "jason.m.borycki@gmail.com",
  invitee_title: "Senior Director Analytics",
  invitee_linkedin: "https://linkedin.com/in/jason-borycki-fsa-maaa-4212836",
  invitee_location: "Huntington Beach, California, United States",
  invitee_headline: "Senior Director Analytics Sound Physicians",
  company_name: "Sound Physicians",
  company_domain: "soundphysicians.com",
  company_linkedin: "https://www.linkedin.com/company/sound-physicians",
  company_description: "Physician-founded and led — with patients at the center of our universe.",
  meeting_at: "2026-09-02T18:00:00Z",
  summary: "Steadywell Intro",
  host: "Josh & Tim",
  campaign: "SW001: Business Leaders",
};

test("the card and thread match the Zap layout, with no dashes and nothing blank", () => {
  const card = buildBookingCard(meeting);
  const cardText = card.blocks.map((block) => block.text.text).join("\n");
  assert.match(cardText, /^\*A new booking has been scheduled!\*/);
  for (const line of ["*Time:* September 02, 2026 @ 2:00 PM EDT", "*Summary:* Steadywell Intro", "*Company:* Sound Physicians", "*Meeting with:* Josh &amp; Tim", "*Campaign:* SW001: Business Leaders"]) {
    assert.ok(cardText.includes(line), line);
  }
  assert.ok(cardText.includes("<mailto:jason.m.borycki@gmail.com|jason.m.borycki@gmail.com>"));

  const info = buildInfoThread(meeting).blocks.map((block) => block.text.text).join("\n");
  assert.match(info, /LEAD INFO/);
  assert.match(info, /COMPANY INFO/);
  assert.ok(info.includes("<https://soundphysicians.com|soundphysicians.com>"));
  assert.ok(!/[—–]/.test(info), "no em or en dashes reach Slack");
  assert.ok(!info.includes("Company Size"), "an empty field is left out");

  assert.deepEqual(buildTldrThread({}).blocks, [], "no TLDR, no empty TLDR message");
  const tldr = buildTldrThread({ leadSummary: "Strong fit.", leadCallFocus: "- Lead with outcomes\n- Pilot path" }).blocks[0].text.text;
  assert.match(tldr, /TLDR/);
  assert.match(tldr, /\*Lead Call Focus:\*\n- Lead with outcomes/);
});

test("a canceled card strikes the time through", () => {
  const text = buildBookingCard({ ...meeting, status: "canceled" }).blocks[0].text.text;
  assert.match(text, /canceled/);
  assert.match(text, /~September 02/);
});

test("steps always start with Slack; webhooks need https", () => {
  assert.deepEqual(normalizeSteps(undefined), [{ id: "slack", type: "slack", enabled: true }]);
  const steps = normalizeSteps([{ type: "hubspot", stage: "x" }, { type: "webhook", url: "http://nope" }, { type: "webhook", url: "https://hooks.example.com/a", label: "Sheet" }]);
  assert.deepEqual(steps.map((step) => step.type), ["slack", "hubspot", "webhook"]);
  assert.equal(steps[2].label, "Sheet");
});

test("the Clay row carries the meeting id and callback URL back", () => {
  const row = clayRow(meeting, { name: "Steadywell", slug: "steadywell" }, "https://qc.example/api/webhooks/clay/booking?secret=s", false);
  assert.equal(row.meeting_id, "m1");
  assert.equal(row.first_name, "Jason");
  assert.equal(row.last_name, "Michael Borycki");
  assert.equal(row.company, "Sound Physicians");
  assert.equal(row.callback_url, "https://qc.example/api/webhooks/clay/booking?secret=s");
});

test("small helpers", () => {
  assert.equal(formatMeetingTime("2026-12-02T19:00:00Z"), "December 02, 2026 @ 2:00 PM EST");
  assert.equal(hostsLabel([{ user_name: "Josh K", user_email: "j@x.com" }, { user_name: "Josh K", user_email: "j2@x.com" }]), "Josh");
  assert.equal(linkedinUrl("nothing here"), "");
});
