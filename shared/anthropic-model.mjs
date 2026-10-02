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

/**
 * The models QC Command is allowed to call, each verified live against the API (Oct 2, 2026).
 *
 * This is an allowlist, not a blocklist: any other id (an old Haiku or Sonnet 4.6 stored on a client, a stale
 * env var, a typo of a live name) resolves to DEFAULT_MODEL instead of reaching the API. A wrong model name
 * once failed silently for days; with an allowlist it cannot get past this function. To adopt a new model,
 * verify it, then add it here.
 */
export const ACTIVE_MODELS = [
  "claude-sonnet-5-5",
  "claude-opus-5-5",
];

/** Every AI feature runs on this unless a client is explicitly set to another allowed model. Sonnet 5.5:
 *  the newest, cheapest current-generation model ($2 / $10 per million tokens, Oct 2026). */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The same default on OpenRouter, which spells versions with a dot. */
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

/** Turn any requested model id into one on the allowlist. Empty, unknown or retired → the default. */
export function resolveModel(requested) {
  const model = typeof requested === "string" ? requested.trim() : "";
  return ACTIVE_MODELS.includes(model) ? model : DEFAULT_MODEL;
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
