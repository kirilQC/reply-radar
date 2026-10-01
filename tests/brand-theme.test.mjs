// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { accentInk, accentOf, DEFAULT_ACCENT, resolveAccent } from "../app/lib/brand-theme.ts";

test("the default accent is the QC Command teal", () => {
  assert.equal(DEFAULT_ACCENT, "#65EBE0");
  assert.equal(resolveAccent(undefined), DEFAULT_ACCENT);
  assert.equal(resolveAccent(""), DEFAULT_ACCENT);
  assert.equal(resolveAccent("not a colour"), DEFAULT_ACCENT);
});

test("an accent a person chose is kept", () => {
  assert.equal(resolveAccent("#ff5a36"), "#ff5a36");
});

test("the old Reply Radar purple counts as never chosen", () => {
  // The appearance panel used to save every field on any change, so the purple on file is a default.
  assert.equal(resolveAccent("#8b7cff"), DEFAULT_ACCENT);
  assert.equal(resolveAccent("#8B7CFF"), DEFAULT_ACCENT);
});

test("text on the accent stays readable whatever the accent is", () => {
  assert.equal(accentInk("#65EBE0"), "#0b0c10"); // light teal -> dark text
  assert.equal(accentInk("#8b7cff"), "#ffffff"); // mid purple -> white text
  assert.equal(accentInk("#1e3a8a"), "#ffffff"); // dark blue -> white text
});

test("only an accent someone picked survives a reload", () => {
  // Saved by "save everything" before the flag existed: nobody chose this pink.
  assert.equal(accentOf({ accent: "#ff4fa3" }), DEFAULT_ACCENT);
  assert.equal(accentOf({ accent: "#ff4fa3", accentChosen: true }), "#ff4fa3");
  assert.equal(accentOf(null), DEFAULT_ACCENT);
  assert.equal(accentOf({ accent: "#8b7cff", accentChosen: true }), DEFAULT_ACCENT);
});
