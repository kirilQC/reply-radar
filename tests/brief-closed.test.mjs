// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { closedMatch, dropClosedItems, struckItems } from "../shared/brief-closed.mjs";

const D = "================================";
// Camb, Oct 7: Ben replied "2. done, 4. done, 5. done, 6. done" and the reply handler struck them.
const oct7 = `${D}

              *:male-technologist: _Things to work on_ :male-technologist:*

${D}

1. <@U0C28GD6JAJ|Ben Hayward> to *send the Notion ideas template to Sahil and Arsalan*
    • _promised to the client on Oct 6, nothing in the channel yet._


2. ~*send the client manual updates on a regular cadence*~
    ~• _said to Arsalan and Sahil on Oct 6 as the stopgap, no update has gone out._~


3. <@U0AT7LWQNH2|Justin> to *give Sahil and Arsalan access to the internal reporting tool, or confirm when*
    • _asked by the client on Oct 6._


4. ~*get CA002 (E-commerce, email) through approval and launched*~
    ~• _approval request posted Oct 5._~


5. ~*handle and track CA001 replies, including Bob Skinstad's*~
    ~• _the client replied to him from internal email on Oct 6._~


6. ~*make sure the client sales team stops replying to our campaign leads*~
    ~• _asked in the client channel on Oct 6._~`;

// Camb, Oct 8, as the model wrote it: two of the closed items back, reworded.
const oct8 = `${D}

              *:male-technologist: _Things to work on_ :male-technologist:*

${D}

1. *restore Jack's access to Camb's HeyReach*
    • his login says the user does not exist


2. <@U0AT7LWQNH2|Justin> to *set up the reporting dashboard and internal system access for Sahil and Arsalan*
    • _Sahil asked for it on the Oct 6 call._


3. *send the Notion ideas tracker to Sahil*
    • _promised "likely tomorrow morning UK time" on Oct 6._


4. *give the CAMB team manual campaign updates on a regular cadence*
    • _committed to Sahil on Oct 6, no update has gone out._


5. <@U0C28GFG2A2|Jack Hayward> to *build the IBC Frankfurt attendee email campaign*
    • _deadline was Friday (Oct 2)._


6. *get CA002 E-commerce (Email) through approval and launched*
    • _submitted Oct 5, no approval or launch posted since._


${D}

            *:hourglass: _Client Bottlenecks_ :hourglass:*

${D}

1. *Akshat reconnected to HeyReach*
    • _asked on the Sep 30 channel._`;

test("the struck items of a brief are read back as closed titles", () => {
  assert.deepEqual(struckItems(oct7), [
    "send the client manual updates on a regular cadence",
    "get CA002 (E-commerce, email) through approval and launched",
    "handle and track CA001 replies, including Bob Skinstad's",
    "make sure the client sales team stops replying to our campaign leads",
  ]);
});

test("Camb Oct 8: the two reworded closed items are removed, everything else stays and is renumbered", () => {
  const { body, dropped } = dropClosedItems(oct8, struckItems(oct7));
  assert.deepEqual(dropped.map((item) => item.title), [
    "give the CAMB team manual campaign updates on a regular cadence",
    "get CA002 E-commerce (Email) through approval and launched",
  ]);
  assert.match(body, /^1\. \*restore Jack's access/m);
  assert.match(body, /^3\. \*send the Notion ideas tracker/m, "an item marked in progress is not closed");
  assert.match(body, /^4\. <@U0C28GFG2A2\|Jack Hayward> to \*build the IBC/m);
  assert.doesNotMatch(body, /regular cadence|CA002/);
  assert.doesNotMatch(body, /committed to Sahil on Oct 6/, "the dropped item's bullets go with it");
  assert.match(body, /Client Bottlenecks[\s\S]*\n1\. \*Akshat reconnected/, "numbering restarts per section");
});

test("a different task about the same thing is not mistaken for a closed one", () => {
  const closed = ["get CA002 (E-commerce, email) through approval and launched"];
  assert.equal(closedMatch("CA002 is running low on pending leads", closed), "");
  assert.equal(closedMatch("send the Notion ideas tracker to Sahil", ["send the client manual updates on a regular cadence"]), "");
  assert.notEqual(closedMatch("Get CA002 approved and launched", closed), "");
});

test("a section left empty says so, and nothing closed means nothing changes", () => {
  const body = `${D}\n\n*Things to work on*\n\n${D}\n\n1. *get CA002 through approval and launched*\n    • _x_\n\n\n${D}\n\n*Client Bottlenecks*\n\n${D}\n\n1. *Akshat on HeyReach*`;
  const result = dropClosedItems(body, ["get CA002 (email) through approval and launched"]);
  assert.match(result.body, /Things to work on\*\n\n=+\n\nNothing open here right now\.\n\n\n=+/);
  assert.equal(dropClosedItems(oct8, []).body, oct8);
});

test("brief memory reads ask for columns rr_slack_briefs actually has", async () => {
  const { readFileSync } = await import("node:fs");
  const run = readFileSync(new URL("../app/lib/morning-brief-run.ts", import.meta.url), "utf8");
  // The table has no `sources` column (it lives in signals.sources); selecting it failed every memory read.
  for (const select of run.match(/rr_slack_briefs\?select=[^&`]+/g) ?? []) {
    assert.doesNotMatch(select, /(?:select=|,)sources(?:,|$)/, select);
  }
  assert.match(run, /recordedChannels:signals->sources->channels/);
});
