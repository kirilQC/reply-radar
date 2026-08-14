// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The block has to survive the next reply, and that comes down entirely to the key.
 *
 * The bug being fixed was that deleting an unwanted person only lasted until their next message, because
 * ingestion rebuilt them from the webhook under a brand new lead id. The block is keyed on the LinkedIn
 * profile URL for that reason — it is the one identifier that persists — so these tests are about the two
 * ways that key can quietly fail: normalising differently from the way ingestion stores the column (a
 * block that never fires), and treating an absent URL as a key (a block that matches everyone).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedProfile, profileKey } from "../shared/blocklist.mjs";

test("the key matches the normalisation ingestion already applies to the column", () => {
  // Lower-cased, query string dropped, trailing slash dropped — the same three steps as
  // `normalizedProfileUrl` in app/lib/heyreach-ingestion.ts. If these ever diverge, a block saves
  // successfully and then never matches anything.
  assert.equal(profileKey("https://www.linkedin.com/in/Jane-Doe/"), "https://www.linkedin.com/in/jane-doe");
  assert.equal(
    profileKey("https://www.linkedin.com/in/jane-doe?utm_source=heyreach&trk=abc"),
    "https://www.linkedin.com/in/jane-doe",
  );
  assert.equal(profileKey("  https://www.linkedin.com/in/jane-doe  "), "https://www.linkedin.com/in/jane-doe");
});

test("the same person arriving three ways produces one key", () => {
  // These are the forms the same profile genuinely turns up in: pasted by hand, off a HeyReach payload
  // with tracking params, and with the trailing slash a browser adds. One block has to cover all three.
  const forms = [
    "https://www.linkedin.com/in/jane-doe",
    "https://www.linkedin.com/in/Jane-Doe/",
    "https://www.linkedin.com/in/jane-doe?originalSubdomain=uk",
  ];
  assert.equal(new Set(forms.map(profileKey)).size, 1);
});

test("nothing usable produces no key", () => {
  for (const value of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(profileKey(value), "", `${JSON.stringify(value)} should not produce a key`);
  }
});

test("a lead with no profile URL is never blocked", () => {
  // The important half of the previous test. An empty key in the blocked set would match every lead that
  // has no profile URL, hiding real leads — and refusing a real lead is far more expensive than storing an
  // unwanted one.
  const blocked = new Set([""]);
  assert.equal(isBlockedProfile("", blocked), false);
  assert.equal(isBlockedProfile(null, blocked), false);
  assert.equal(isBlockedProfile(undefined, blocked), false);
});

test("a blocked profile is recognised however the next reply spells it", () => {
  const blocked = new Set([profileKey("https://www.linkedin.com/in/jane-doe")]);
  assert.equal(isBlockedProfile("https://www.linkedin.com/in/Jane-Doe/", blocked), true);
  assert.equal(isBlockedProfile("https://www.linkedin.com/in/jane-doe?utm_source=x", blocked), true);
  assert.equal(isBlockedProfile("https://www.linkedin.com/in/john-doe", blocked), false);
});

test("an empty block list blocks nobody", () => {
  assert.equal(isBlockedProfile("https://www.linkedin.com/in/jane-doe", new Set()), false);
});
