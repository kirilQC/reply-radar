// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The HeyReach client is read-only, and this is what keeps it that way.
 *
 * "Read-only" is a decision the owner made explicitly when the assistant was scoped, and it is
 * currently guaranteed by the fact that no function capable of writing exists in the module. That is
 * a strong guarantee and an invisible one — nothing in the file stops a future change from adding
 * `sendMessage` next to `conversations`, and the assistant would pick it up as a callable tool
 * without anybody deciding that it should.
 *
 * So the guarantee is asserted rather than assumed. These tests do no network work: they read the
 * module's exported surface, which is exactly the surface the assistant can reach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as heyreach from "../app/lib/heyreach-api.ts";

/**
 * Verbs that would mean this module had stopped being read-only.
 *
 * Taken from HeyReach's own write endpoints — it can send messages, add and delete leads, create and
 * pause campaigns, replace tags and register webhooks — plus the words a wrapper for one of those
 * would plausibly be given.
 */
const MUTATING = [
  "send", "post", "write", "create", "add", "insert", "update", "patch", "edit", "set",
  "delete", "remove", "purge", "clear", "pause", "resume", "start", "stop", "cancel",
  "tag", "untag", "block", "assign", "move", "replace", "enroll", "import", "upload",
];

/**
 * True when `name` begins with `verb` as a whole word: `sendMessage` does, `senderById` does not.
 * Without the boundary the list would reject perfectly good readers for sharing a prefix with a
 * write, and a test that cries wolf gets deleted rather than fixed.
 */
const startsWithVerb = (name, verb) =>
  name.toLowerCase().startsWith(verb) &&
  (name.length === verb.length || name[verb.length] === name[verb.length].toUpperCase());

test("no exported function has a mutating name", () => {
  for (const name of Object.keys(heyreach)) {
    const offender = MUTATING.find((verb) => startsWithVerb(name, verb));
    assert.equal(
      offender,
      undefined,
      `"${name}" looks like a write. The assistant calls this module, and read-only is a deliberate decision — if a write really is wanted, that decision has to be revisited on purpose.`,
    );
  }
});

test("every export is callable", () => {
  // A stray exported object would be state shared across requests, which on a serverless function is
  // a cache nobody asked for and a way for one client's data to be answered for another's.
  for (const [name, value] of Object.entries(heyreach)) {
    assert.equal(typeof value, "function", `${name} should be a function, got ${typeof value}`);
  }
});

test("the whole probed read surface is still wrapped", () => {
  // Each of these was confirmed against a live HeyReach account. Dropping one because nothing calls
  // it yet throws away a verified endpoint, so removal should be a conscious edit to this list.
  const expected = [
    "checkApiKey",
    "campaigns", "campaignById", "campaignSequence", "campaignPendingLeads", "campaignsForLead",
    "senders", "senderById", "network",
    "lists", "listById", "leadsInList", "companiesInList", "listsForLead",
    "lead", "leadTags",
    "overallStats", "statsByCampaign",
    "conversations",
  ];
  for (const name of expected) {
    assert.equal(typeof heyreach[name], "function", `${name} is missing from the HeyReach client`);
  }
});
