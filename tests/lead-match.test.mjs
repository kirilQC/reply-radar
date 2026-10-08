// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { cleanEmailBody, replyText } from "../shared/email-text.mjs";
import { linkedinFromVariables, nameKey, pickLinkedInLead, sameCompany } from "../shared/lead-match.mjs";

test("Megan's reply loses the signature images and social links", () => {
  const body = "I'm not interested - please remove me from your contact list. --- [https://lh6.googleusercontent.com/10SYm2yAxYgZUQatNN_UUfToz20xmFDDuDZlwi8Pv-0zjow17QnBC0zlLftuwKKlBDwcP5grQTGgqiCaA1OtzcVWJ8FGxlwdhY746X3oJghjWpr7krcaKcYJMzb1tkDRRJQYeuOzk0z0Ev1wM] Megan Kolbe Head of Growth [https://lh6.googleusercontent.com/M3l2z_638ba7b9maendHYiBzEZ8T4x1wpASQaE] <http://www.facebook.com/kurufootwear/> [https://lh4.googleusercontent.com/Y9on9SCGQ] <http://www.instagram.com/kurufootwear/> <http://www.youtube.com/@kurufootwear>";
  assert.equal(cleanEmailBody(body), "I'm not interested - please remove me from your contact list.");
});

test("signatures and phone footers are cut, the words kept", () => {
  assert.equal(cleanEmailBody("Sounds good, Tuesday works.\n\n-- \nJane Doe\nVP Sales | Acme\nwww.acme.com"), "Sounds good, Tuesday works.");
  assert.equal(cleanEmailBody("Yes please send it\n\nSent from my iPhone"), "Yes please send it");
  assert.equal(cleanEmailBody("Let's talk [cid:image001.png@01DA] next week"), "Let's talk next week");
  assert.equal(cleanEmailBody("---\nonly a rule"), "---\nonly a rule", "a body that opens with the marker keeps its text");
  assert.equal(replyText({ text_body: "Sure!\n\nOn Tue, Oct 7, 2026 at 9:00 AM Paula <p@camb.ai> wrote:\n> How are you handling…" }), "Sure!");
});

test("the email person is matched to their LinkedIn lead by name, then company", () => {
  const candidates = [
    { id: "a", name: "Megan Kolbe, MBA", company: "KURU Footwear" },
    { id: "b", name: "Roohi Jeelani 🌸", company: "ONTO Health" },
    { id: "c", name: "John Smith", company: "Acme" },
    { id: "d", name: "John Smith", company: "Globex Corp" },
  ];
  assert.equal(pickLinkedInLead({ name: "Megan Kolbe", company: "Kuru" }, candidates)?.id, "a");
  assert.equal(pickLinkedInLead({ name: "Roohi Jeelani", company: "ONTO Health Inc." }, candidates)?.id, "b");
  assert.equal(pickLinkedInLead({ name: "John Smith", company: "Globex" }, candidates)?.id, "d", "same name: the company decides");
  assert.equal(pickLinkedInLead({ name: "John Smith", company: "" }, candidates), null, "same name and no company: no guess");
  assert.equal(pickLinkedInLead({ name: "Megan", company: "KURU" }, candidates), null, "a first name alone is not enough");
  assert.equal(nameKey("José María (Pepe) García-López"), "jose garcialopez");
  assert.ok(sameCompany("KURU Footwear, Inc.", "Kuru"));
  assert.ok(!sameCompany("Acme", "Globex"));
});

test("a LinkedIn URL in Email Bison's custom variables is read", () => {
  assert.equal(linkedinFromVariables([{ name: "linkedin_url", value: "https://www.linkedin.com/in/megan-kolbe-123/?utm=x" }]), "megan-kolbe-123");
  assert.equal(linkedinFromVariables([{ name: "phone", value: "555" }]), "");
});
