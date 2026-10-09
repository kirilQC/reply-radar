// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanMention, threadToTurns } from "../shared/slack-agent.mjs";
import { briefReplyUserContent } from "../shared/brief-reply.mjs";

const names = new Map([["U09BWJMV8DT", "Kiril Ivlev"], ["UBOT", "QC Bot"]]);

test("a tagged teammate reaches the model as name and mention; only the bot's own mention is removed", () => {
  assert.equal(
    cleanMention("<@UBOT> number 1 shouldnt be assigned to luke, assign to <@U09BWJMV8DT> instead", { names, botUserId: "UBOT" }),
    "number 1 shouldnt be assigned to luke, assign to @Kiril Ivlev (<@U09BWJMV8DT>) instead",
  );
  // "@QC Bot @Kiril Ivlev" is not an empty message any more.
  assert.equal(cleanMention("<@UBOT> <@U09BWJMV8DT>", { names, botUserId: "UBOT" }), "@Kiril Ivlev (<@U09BWJMV8DT>)");
});

test("without names, every mention is stripped as before", () => {
  assert.equal(cleanMention("<@UBOT> how did Cotool do"), "how did Cotool do");
});

test("thread turns keep tagged teammates when names are given", () => {
  const turns = threadToTurns([{ author: "U1", botId: "", text: "<@UBOT> give it to <@U09BWJMV8DT>" }], { userId: "UBOT" }, names);
  assert.equal(turns[0].content, "give it to @Kiril Ivlev (<@U09BWJMV8DT>)");
});

test("the brief editor is handed the team so a typed name becomes a mention", () => {
  const content = briefReplyUserContent({ body: "1. Luma link (<@U0680D1FNER>)", replies: ["assign 1 to kiril ivlev"], roster: "Kiril Ivlev = <@U09BWJMV8DT>" });
  assert.match(content, /# The team[\s\S]*Kiril Ivlev = <@U09BWJMV8DT>/);
});

test("QC Bot never pings the never-ping list: every Slack send goes through the filter", () => {
  const slack = readFileSync(new URL("../app/lib/slack.ts", import.meta.url), "utf8");
  assert.match(slack, /const NEVER_PING_DEFAULT = \["U0680D1FNER"\]/);
  for (const fn of ["postMessage", "updateMessage", "postEphemeral"]) {
    assert.match(slack, new RegExp(`export async function ${fn}\\([^)]*rawText[\\s\\S]{0,200}withoutNeverPings\\(rawText\\)`), `${fn} filters`);
  }
});

test("the brief editor reads the conversation in the thread, so a short answer completes the earlier ask", () => {
  const history = "Kiril Ivlev: number 1 shouldnt be assigned to luke, assign to kiril ivlev instead\nQC Bot (you): Who should I put on it?";
  const content = briefReplyUserContent({ body: "1. Luma link (<@U0680D1FNER>)", replies: ["@Kiril Ivlev (<@U09BWJMV8DT>)"], history });
  assert.match(content, /# The conversation so far in this thread[\s\S]*assign to kiril ivlev instead[\s\S]*Who should I put on it\?[\s\S]*# The teammate's reply/);
  const route = readFileSync(new URL("../app/api/slack/events/route.ts", import.meta.url), "utf8");
  assert.match(route, /replyToBrief\(\{[^}]*posts \}\)/);
  assert.match(route, /writeBriefReply\(briefThread\.automation, briefThread\.body, replies, await rosterLine\(\), history\)/);
});
