// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Client logos and teammate photos are stored as base64 data URLs. Sent inline they made list responses
 * enormous (the audit log was 7 MB, 92% of it the same logos repeated on every row) and were re-downloaded
 * on every page load. `slimImages` swaps every embedded image in a JSON response for a short, content-hashed
 * `/api/img/<hash>` URL that the browser caches forever, and `/api/img/[hash]` serves the bytes.
 *
 * A save path must never write one of these URLs back over the stored image: `isImageRef` tells it to keep
 * what is stored.
 */

import { createHash } from "node:crypto";

export const imageHash = (dataUrl: string) => createHash("sha1").update(dataUrl).digest("hex").slice(0, 20);

const PREFIX = "/api/img/";
export const isImageRef = (value: unknown) => typeof value === "string" && value.startsWith(PREFIX);

/** Deep-copies `value`, replacing every `data:image/…` string with its `/api/img/<hash>` URL. */
export function slimImages<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.startsWith("data:image/") ? `${PREFIX}${imageHash(v)}` : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
