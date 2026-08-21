// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import {
  slugify,
  computeProgress,
  parentIsDone,
  groupTasks,
  nextPosition,
  positionsForOrder,
  checkoffMessage,
  completionMessage,
} from "../shared/onboarding.mjs";

test("slugify lowercases, collapses punctuation to single hyphens, and trims the ends", () => {
  assert.equal(slugify("Bluevia Health"), "bluevia-health");
  assert.equal(slugify("  Open   NeuroTech!! "), "open-neurotech");
  assert.equal(slugify("A&B  Co."), "a-b-co");
  assert.equal(slugify(""), "");
  assert.equal(slugify("***"), "", "a name that is all punctuation slugs to empty rather than to a hyphen");
});

test("computeProgress counts leaves only, so a parent's children are the units and the parent is not double-counted", () => {
  const tasks = [
    { id: "p", parentId: null, isDone: false }, // parent — not a leaf
    { id: "c1", parentId: "p", isDone: true },
    { id: "c2", parentId: "p", isDone: false },
    { id: "solo", parentId: null, isDone: true }, // childless top-level — a leaf
  ];
  const progress = computeProgress(tasks);
  assert.equal(progress.totalLeaves, 3, "two children plus one childless top-level, the parent excluded");
  assert.equal(progress.doneLeaves, 2);
  assert.equal(progress.pct, 67);
  assert.equal(progress.complete, false);
});

test("computeProgress reports complete only when every leaf is done", () => {
  const tasks = [
    { id: "p", parentId: null, isDone: false },
    { id: "c1", parentId: "p", isDone: true },
    { id: "c2", parentId: "p", isDone: true },
  ];
  const progress = computeProgress(tasks);
  assert.equal(progress.pct, 100);
  assert.equal(progress.complete, true);
});

test("computeProgress treats an empty checklist as unstarted, never complete", () => {
  const progress = computeProgress([]);
  assert.deepEqual(progress, { doneLeaves: 0, totalLeaves: 0, pct: 0, complete: false });
});

test("parentIsDone is true only when a parent has children and all are done", () => {
  const tasks = [
    { id: "c1", parentId: "p", isDone: true },
    { id: "c2", parentId: "p", isDone: true },
  ];
  assert.equal(parentIsDone({ id: "p" }, tasks), true);
  assert.equal(parentIsDone({ id: "p" }, [{ id: "c1", parentId: "p", isDone: false }]), false);
  assert.equal(parentIsDone({ id: "childless" }, tasks), false, "a parent with no children is not 'done' by vacuous truth");
});

test("groupTasks nests children under parents, both in position order, with a derived done", () => {
  const tasks = [
    { id: "b", parentId: null, position: 200, isDone: false, title: "second" },
    { id: "a", parentId: null, position: 100, isDone: true, title: "first" },
    { id: "a2", parentId: "a", position: 20, isDone: true, title: "a-two" },
    { id: "a1", parentId: "a", position: 10, isDone: false, title: "a-one" },
  ];
  const grouped = groupTasks(tasks);
  assert.deepEqual(grouped.map((g) => g.title), ["first", "second"], "top-level sorted by position");
  assert.deepEqual(grouped[0].children.map((c) => c.title), ["a-one", "a-two"], "children sorted by position");
  assert.equal(grouped[0].done, false, "parent with an undone child is not done, regardless of its own flag");
  assert.equal(grouped[1].done, false, "a childless top-level uses its own flag");
});

test("groupTasks surfaces an orphan as top-level rather than dropping it", () => {
  const grouped = groupTasks([{ id: "x", parentId: "missing", position: 100, title: "orphan" }]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].title, "orphan");
});

test("nextPosition appends after the furthest sibling", () => {
  assert.equal(nextPosition([{ position: 100 }, { position: 300 }]), 400);
  assert.equal(nextPosition([]), 100);
});

test("positionsForOrder spaces a reordered id list evenly", () => {
  assert.deepEqual(positionsForOrder(["x", "y", "z"]), [
    { id: "x", position: 100 },
    { id: "y", position: 200 },
    { id: "z", position: 300 },
  ]);
});

test("checkoffMessage bolds the client and step, prefixes a sub-step with its parent, and names who when known", () => {
  const top = checkoffMessage({ clientName: "Bluevia", taskTitle: "Book kickoff call", doneLeaves: 4, totalLeaves: 30, pct: 13 });
  assert.match(top, /\*Bluevia\*/);
  assert.match(top, /\*Book kickoff call\*/);
  assert.match(top, /4\/30 \(13%\)/);
  assert.doesNotMatch(top, /›/, "a top-level step has no parent prefix");

  const sub = checkoffMessage({ clientName: "Bluevia", parentTitle: "Set up client in Reply Radar", taskTitle: "Connect HeyReach API key", doneBy: "Luke", doneLeaves: 20, totalLeaves: 30, pct: 67 });
  assert.match(sub, /Set up client in Reply Radar › \*Connect HeyReach API key\*/);
  assert.match(sub, /_Luke_/, "the person is in italics");
});

test("checkoffMessage carries no Slack mention pill, so it can never misfire an @", () => {
  const message = checkoffMessage({ clientName: "Bluevia", taskTitle: "Ask client for DNC", doneLeaves: 1, totalLeaves: 30, pct: 3 });
  assert.doesNotMatch(message, /<@/);
});

test("completionMessage announces the finish once, with the step count", () => {
  const message = completionMessage({ clientName: "Bluevia", totalLeaves: 30, doneBy: "Luke" });
  assert.match(message, /:tada:/);
  assert.match(message, /\*Bluevia\* is fully onboarded/);
  assert.match(message, /all 30 steps complete/);
});
