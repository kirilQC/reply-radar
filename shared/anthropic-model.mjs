// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The one place that knows which Anthropic models are alive.
 *
 * Anthropic retires older models, and a request to a retired one fails with `not_found_error` — the exact
 * failure that took out 129 requests when a client was still pinned to Opus 4.1. A stored model id (a client
 * config, the ANTHROPIC_MODEL env, a request body) can be stale, so every model id is run through
 * `resolveModel` on its way to the API: a known-retired id is swapped for its active replacement, and anything
 * unknown is passed through unchanged (so a genuinely new id is never blocked). One character off still fails —
 * this catches the ids we know are dead, not typos of live ones.
 */

// Retired id → the active model to use instead. Add a row here whenever Anthropic retires one.
const RETIRED_TO_ACTIVE = {
  "claude-opus-4-1-20250805": "claude-opus-5",
  "claude-opus-4-1": "claude-opus-5",
  "claude-opus-4-6": "claude-opus-5",
  "claude-opus-4-20250514": "claude-opus-5",
  "claude-3-opus-20240229": "claude-opus-5",
  "claude-3-5-sonnet-latest": "claude-sonnet-4-6",
  "claude-3-5-sonnet-20241022": "claude-sonnet-4-6",
  "claude-3-5-sonnet-20240620": "claude-sonnet-4-6",
  "claude-3-5-haiku-latest": "claude-haiku-4-5-20251001",
  "claude-3-5-haiku-20241022": "claude-haiku-4-5-20251001",
  "claude-3-haiku-20240307": "claude-haiku-4-5-20251001",
};

/** The models offered in the config dropdown, all confirmed active as of the Opus 4.1 retirement (Aug 2026). */
export const ACTIVE_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

/** The safe default when nothing is configured — the working workhorse the app has run on. */
export const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Turn any requested model id into one that is actually online. Empty → the default. */
export function resolveModel(requested) {
  const model = typeof requested === "string" ? requested.trim() : "";
  if (!model) return DEFAULT_MODEL;
  return RETIRED_TO_ACTIVE[model] || model;
}

/**
 * Whether a model still accepts the `temperature` parameter.
 *
 * The Claude 5 family (opus-5, sonnet-5, fable-5) and Opus 4.8 deprecated it: sending `temperature` — even
 * `temperature: 0` — is rejected with a 400 "`temperature` is deprecated for this model." Older models
 * (Haiku 4.5, Sonnet 4.5/4.6) still take it. Callers use this to omit the field for the models that refuse it.
 */
export function supportsTemperature(requested) {
  const model = typeof requested === "string" ? requested : "";
  if (/\b(?:opus|sonnet|haiku|fable)-5\b/.test(model)) return false;
  if (model.includes("opus-4-8")) return false;
  return true;
}

/** The temperature fragment to spread into a request body — `{ temperature }` for models that accept it, else `{}`. */
export function temperatureField(model, temperature) {
  return supportsTemperature(model) ? { temperature } : {};
}
