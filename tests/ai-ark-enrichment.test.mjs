import assert from "node:assert/strict";
import test from "node:test";
import { extractAiArkEnrichment } from "../app/lib/ai-ark-enrichment.ts";

const person = {
  id: "person-1",
  profile: { headline: "Founder building useful things", title: "CEO", picture: { source: "https://images.example/lead.jpg" } },
  position_groups: [
    { company: { name: "Wrong Company", logo: "https://images.example/wrong.png" } },
    { company: { name: "Test Company Name", logo: "https://images.example/right.png" } },
  ],
  skills: ["Sales", "Security"],
  statistics: { network: { followers_count: 42 } },
};

test("extracts AI Ark profile data and exact matching company logo", () => {
  const result = extractAiArkEnrichment(person, " test company name ");
  assert.equal(result.profilePhotoUrl, "https://images.example/lead.jpg");
  assert.equal(result.companyPhotoUrl, "https://images.example/right.png");
  assert.equal(result.headline, "Founder building useful things");
  assert.deepEqual(result.skills, ["Sales", "Security"]);
  assert.equal(result.providerPersonId, "person-1");
});

test("falls back to partial company-name matching", () => {
  const result = extractAiArkEnrichment({ ...person, position_groups: [{ company: { name: "Acme Holdings", logo: "https://images.example/acme.png" } }] }, "Acme Holdings LLC");
  assert.equal(result.companyPhotoUrl, "https://images.example/acme.png");
});
