import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAiArkEnrichment,
  selectAiArkPerson,
} from "../app/lib/ai-ark-enrichment.ts";
import {
  isAiArkEnrichmentEnabled,
  leadRollup,
  mergeLeadAttributions,
} from "../app/lib/lead-identity.ts";

const person = {
  id: "person-1",
  profile: {
    headline: "Founder building useful things",
    title: "CEO",
    picture: { source: "https://images.example/lead.jpg" },
  },
  position_groups: [
    {
      company: {
        name: "Wrong Company",
        logo: "https://images.example/wrong.png",
      },
    },
    {
      company: {
        name: "Test Company Name",
        logo: "https://images.example/right.png",
      },
    },
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
  const result = extractAiArkEnrichment(
    {
      ...person,
      position_groups: [
        {
          company: {
            name: "Acme Holdings",
            logo: "https://images.example/acme.png",
          },
        },
      ],
    },
    "Acme Holdings LLC",
  );
  assert.equal(result.companyPhotoUrl, "https://images.example/acme.png");
});

test("selects the exact LinkedIn person instead of trusting the first search result", () => {
  const wrong = {
    ...person,
    id: "wrong",
    link: { linkedin: "https://linkedin.com/in/someone-else" },
  };
  const right = {
    ...person,
    id: "right",
    link: { linkedin: "https://www.linkedin.com/in/sean-sokhanvar/" },
  };
  assert.equal(
    selectAiArkPerson(
      { content: [wrong, right] },
      "https://linkedin.com/in/sean-sokhanvar",
    ),
    right,
  );
  assert.equal(
    selectAiArkPerson(
      { content: [wrong] },
      "https://linkedin.com/in/sean-sokhanvar",
    ),
    null,
  );
});

test("global AI Ark switch only enables explicit truthy values", () => {
  assert.equal(isAiArkEnrichmentEnabled("true"), true);
  assert.equal(isAiArkEnrichmentEnabled("1"), true);
  assert.equal(isAiArkEnrichmentEnabled("false"), false);
  assert.equal(isAiArkEnrichmentEnabled(undefined), false);
});

test("lead attribution keeps distinct campaigns and senders without duplicating a conversation attribution", () => {
  const first = {
    workspaceId: "client-a",
    conversationId: "conversation-1",
    campaignId: "campaign-1",
    senderId: "sender-1",
    senderName: "Alex",
    lastSeenAt: "2026-08-08T10:00:00Z",
  };
  const secondCampaign = {
    workspaceId: "client-a",
    conversationId: "conversation-2",
    campaignId: "campaign-2",
    senderId: "sender-2",
    senderName: "Sam",
    lastSeenAt: "2026-08-08T11:00:00Z",
  };
  const refreshed = {
    ...first,
    senderName: "Alex Sender",
    lastSeenAt: "2026-08-08T12:00:00Z",
  };
  const result = mergeLeadAttributions(
    mergeLeadAttributions([], first),
    secondCampaign,
  );
  const updated = mergeLeadAttributions(result, refreshed);
  assert.equal(updated.length, 2);
  assert.equal(
    updated.find((row) => row.conversationId === "conversation-1").senderName,
    "Alex Sender",
  );
  assert.equal(
    updated.find((row) => row.conversationId === "conversation-2").campaignId,
    "campaign-2",
  );
});

test("lead rollup produces readable semicolon summaries across clients, campaigns, and senders", () => {
  const result = leadRollup([
    {
      workspaceId: "a",
      workspaceName: "Client One",
      conversationId: "c1",
      campaignName: "Campaign 1",
      senderName: "Adam",
    },
    {
      workspaceId: "b",
      workspaceName: "Client Two",
      conversationId: "c2",
      campaignName: "Campaign 2",
      senderName: "James",
    },
    {
      workspaceId: "a",
      workspaceName: "Client One",
      conversationId: "c1",
      campaignName: "Campaign 1",
      senderName: "Adam",
    },
  ]);
  assert.equal(result.client_names, "Client One; Client Two");
  assert.equal(result.campaign_names, "Campaign 1; Campaign 2");
  assert.equal(result.sender_names, "Adam; James");
  assert.equal(result.client_count, 2);
  assert.equal(result.campaign_count, 2);
  assert.equal(result.conversation_count, 2);
});
