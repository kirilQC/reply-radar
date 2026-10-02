import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVE_MODELS, DEFAULT_MODEL, OPENROUTER_DEFAULT_MODEL, resolveModel, temperatureField } from "../shared/anthropic-model.mjs";

test("the default is Sonnet 5.5 and is on the allowlist", () => {
  assert.equal(DEFAULT_MODEL, "claude-sonnet-5-5");
  assert.ok(ACTIVE_MODELS.includes(DEFAULT_MODEL));
  assert.equal(OPENROUTER_DEFAULT_MODEL, "anthropic/claude-sonnet-5.5");
});

test("old, retired, unknown and misspelled ids all resolve to the default", () => {
  for (const id of ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-1", "claude-sonnet-5", "claude-sonnet-5.5", "claude-sonet-5-5", "", undefined, null, 42]) {
    assert.equal(resolveModel(id), DEFAULT_MODEL, String(id));
  }
});

test("allowlisted ids pass through", () => {
  for (const id of ACTIVE_MODELS) assert.equal(resolveModel(` ${id} `), id);
});

test("Claude 5 one-shot calls send no temperature and switch thinking off", () => {
  for (const id of ACTIVE_MODELS) assert.deepEqual(temperatureField(id, 0), { thinking: { type: "disabled" } }, id);
  assert.deepEqual(temperatureField(OPENROUTER_DEFAULT_MODEL, 0), {});
});
