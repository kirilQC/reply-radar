// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The join between a Reply Radar workspace and a QC Brain folder.
 *
 * This is the load-bearing guess in the whole feature. Everything the two systems do for each other
 * — a client's real logo, their live campaign figures under a strategy note, a lead count beside an
 * ICP — is downstream of it, and a wrong answer here does not look like a bug. It looks like one
 * client's numbers sitting under another client's name, which nobody would think to question.
 *
 * So the cases below are the real names out of both systems, including the ones that disagree.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { brainFolderFor, linkWorkspaces, normaliseName } from "../shared/brain-link.mjs";

const FOLDERS = ["willow", "bluevia-health", "Steadywell", "cotool", "venn", "webrix", "harbor-point-capital"];

test("names meet once punctuation and case stop mattering", () => {
  assert.equal(normaliseName("Bluevia Health"), "blueviahealth");
  assert.equal(normaliseName("bluevia-health"), "blueviahealth");
  assert.equal(normaliseName("Bluevia_Health!"), "blueviahealth");
  assert.equal(normaliseName(""), "");
  assert.equal(normaliseName(undefined), "");
});

test("a folder a person chose beats every rule", () => {
  const workspace = { slug: "willow", name: "Willow", brainFolder: "harbor-point-capital" };
  assert.deepEqual(brainFolderFor(workspace, FOLDERS), { folder: "harbor-point-capital", how: "chosen" });
});

test("a chosen folder is returned even if it is no longer in the repo", () => {
  // Falling back to a guess here would hide the rename, and the rename is the thing worth knowing.
  const workspace = { slug: "willow", name: "Willow", brainFolder: "willow-old" };
  assert.deepEqual(brainFolderFor(workspace, FOLDERS), { folder: "willow-old", how: "chosen" });
});

test("the slug is trusted before the display name", () => {
  assert.deepEqual(brainFolderFor({ slug: "webrix", name: "Willow" }, FOLDERS), { folder: "webrix", how: "slug" });
});

test("a display name matches a folder written as words", () => {
  assert.deepEqual(brainFolderFor({ slug: "bvh", name: "Bluevia Health" }, FOLDERS), {
    folder: "bluevia-health",
    how: "name",
  });
  // A capitalised folder is somebody's typing, not a different client.
  assert.deepEqual(brainFolderFor({ slug: "sw", name: "steadywell" }, FOLDERS), { folder: "Steadywell", how: "name" });
});

test("a longer name still finds its folder, and says the match was loose", () => {
  assert.deepEqual(brainFolderFor({ slug: "willow-health", name: "Willow Health" }, FOLDERS), {
    folder: "willow",
    how: "loose",
  });
});

test("short generic words cannot bridge two unrelated clients", () => {
  const folders = ["acme", "labs", "venn"];
  // "venn" is four letters: under the floor, so it cannot be matched by containment alone.
  assert.deepEqual(brainFolderFor({ slug: "venn-capital", name: "Venn Capital" }, folders), { folder: "", how: "" });
});

test("no match is a plain answer, not a failure", () => {
  assert.deepEqual(brainFolderFor({ slug: "nobody", name: "Nobody Inc" }, FOLDERS), { folder: "", how: "" });
  assert.deepEqual(brainFolderFor({ slug: "", name: "" }, FOLDERS), { folder: "", how: "" });
  assert.deepEqual(brainFolderFor({ slug: "willow", name: "Willow" }, []), { folder: "", how: "" });
});

test("looking from the folder's side gives the same answers as from the workspace's", () => {
  const workspaces = [
    { slug: "willow", name: "Willow" },
    { slug: "bvh", name: "Bluevia Health" },
    { slug: "nobody", name: "Nobody Inc" },
  ];
  const links = linkWorkspaces(workspaces, FOLDERS);
  assert.equal(links.get("willow").workspace.slug, "willow");
  assert.equal(links.get("willow").how, "slug");
  assert.equal(links.get("bluevia-health").workspace.slug, "bvh");
  // A folder nobody is set up for is simply absent, which is the normal case for a prospect.
  assert.equal(links.has("venn"), false);
  assert.equal(links.size, 2);
});

test("when two workspaces want one folder the more deliberate one wins", () => {
  const workspaces = [
    { slug: "willow-health", name: "Willow Health" },
    { slug: "willow", name: "Willow" },
  ];
  // Guessed loosely versus matched on the slug: the slug wins, whatever order they arrive in.
  assert.equal(linkWorkspaces(workspaces, FOLDERS).get("willow").workspace.slug, "willow");
  assert.equal(linkWorkspaces([...workspaces].reverse(), FOLDERS).get("willow").workspace.slug, "willow");

  const chosen = [
    { slug: "willow", name: "Willow" },
    { slug: "second", name: "Second", brainFolder: "willow" },
  ];
  assert.equal(linkWorkspaces(chosen, FOLDERS).get("willow").workspace.slug, "second");
});
