/**
 * Who a preference belongs to.
 *
 * There is no login, so "who is this" has to be answered by the browser. Two teammates
 * open the same client inbox and both expect their own accent, their own layout, their own
 * pane position — so preferences cannot be keyed by the thing they are looking at (which is
 * what `client:nok` did: one shared row per client, last writer wins).
 *
 * IP was the obvious idea and is the wrong one: an office shares a single egress IP, so the
 * two teammates we are trying to separate would collide exactly, while a phone on cellular
 * or anyone on a VPN changes IP and silently loses their settings. A cookie identifies the
 * browser instead, which is what personalisation actually means here.
 *
 * Identity resolves in two steps:
 *   1. an active profile (set the moment someone opens /inbox?profile=<slug>) — follows the
 *      person to any machine they open the app on;
 *   2. otherwise the device id — a random value minted once per browser.
 *
 * Layout keys hang off identity (`<identity>::client:nok`), so layout stays per person AND
 * per client, while appearance is stored on the identity alone and therefore applies to
 * every page of the site.
 */

const DEVICE_COOKIE = "rr-device";
const PROFILE_COOKIE = "rr-profile";
const DEVICE_STORAGE_KEY = "reply-radar-device";
const TWO_YEARS = 60 * 60 * 24 * 730;

function readCookie(name: string) {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return "";
  try {
    return decodeURIComponent(match.slice(name.length + 1));
  } catch {
    return "";
  }
}

function writeCookie(name: string, value: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${TWO_YEARS}; samesite=lax`;
}

function readStored(key: string) {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    // Private browsing can refuse localStorage; the cookie alone still works.
    return "";
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* nothing to fall back to, and nothing worth breaking over */
  }
}

/** Stable per-browser id, minted on first use. Mirrored so losing either copy is survivable. */
export function deviceId() {
  if (typeof window === "undefined") return "";
  const fromCookie = readCookie(DEVICE_COOKIE);
  const fromStorage = readStored(DEVICE_STORAGE_KEY);
  const id =
    fromCookie ||
    fromStorage ||
    (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  if (id !== fromCookie) writeCookie(DEVICE_COOKIE, id);
  if (id !== fromStorage) writeStored(DEVICE_STORAGE_KEY, id);
  return id;
}

export function activeProfile() {
  return readCookie(PROFILE_COOKIE);
}

/** Remembers the profile someone arrived as, so their settings follow them off the inbox. */
export function setActiveProfile(slug: string) {
  if (!slug || slug === activeProfile()) return;
  writeCookie(PROFILE_COOKIE, slug);
}

export function identityKey() {
  if (typeof window === "undefined") return "general";
  const profile = activeProfile();
  return profile ? `profile:${profile}` : `device:${deviceId()}`;
}

/** Where appearance is cached locally. Server-side it lives under the identity key. */
export function appearanceStorageKey() {
  return `reply-radar-prefs:${identityKey()}`;
}

/** Layout is per person and per thing-being-looked-at. */
export function layoutStorageKey(scope: string) {
  return `reply-radar-layout:${identityKey()}::${scope}`;
}

export function layoutKey(scope: string) {
  return `${identityKey()}::${scope}`;
}

/**
 * Reads whichever appearance this browser has, preferring the current identity and falling
 * back to the pre-identity key so nobody's saved look resets the first time they load this.
 */
export function readCachedAppearanceEntry(): {
  appearance: Record<string, unknown>;
  /** False when this came from the shared fallback and therefore may belong to someone else. */
  exact: boolean;
} | null {
  if (typeof window === "undefined") return null;
  const keys = [appearanceStorageKey(), "reply-radar-prefs:general"];
  for (const [index, key] of keys.entries()) {
    try {
      const parsed = JSON.parse(readStored(key) || "null");
      if (parsed?.appearance)
        return {
          appearance: parsed.appearance as Record<string, unknown>,
          exact: index === 0,
        };
    } catch {
      /* try the next key */
    }
  }
  return null;
}

export function readCachedAppearance(): Record<string, unknown> | null {
  return readCachedAppearanceEntry()?.appearance ?? null;
}

export function writeCachedAppearance(appearance: unknown) {
  if (typeof window === "undefined") return;
  writeStored(appearanceStorageKey(), JSON.stringify({ appearance }));
  // Kept in step so any page still reading the old key sees the same look.
  writeStored("reply-radar-prefs:general", JSON.stringify({ appearance }));
}
