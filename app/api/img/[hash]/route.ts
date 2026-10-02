// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Serves a stored logo or teammate photo by the content hash `slimImages` put in its place.
 *
 * The hash is of the image itself, so a URL never changes meaning and the browser may cache it forever.
 * The first request on a cold server reads every stored image once and indexes it by hash; later ones are
 * served from that index.
 */

import { imageHash } from "../../../lib/image-refs";

const index = new Map<string, string>();
let builtAt = 0;

async function rebuild(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const read = async (path: string) => {
    const r = await fetch(`${url}/rest/v1/${path}`, { headers, cache: "no-store" }).catch(() => null);
    return r?.ok ? ((await r.json()) as Array<Record<string, unknown>>) : [];
  };
  const [workspaces, profiles] = await Promise.all([
    read("rr_workspaces?select=logo_url&logo_url=like.data:image*"),
    read("rr_profiles?select=avatar_url&avatar_url=like.data:image*"),
  ]);
  for (const row of [...workspaces, ...profiles]) {
    const value = String(row.logo_url ?? row.avatar_url ?? "");
    if (value.startsWith("data:image/")) index.set(imageHash(value), value);
  }
  builtAt = Date.now();
}

export async function GET(_request: Request, context: { params: Promise<{ hash: string }> }) {
  const { hash } = await context.params;
  if (!/^[a-f0-9]{20}$/.test(hash)) return new Response("Not found", { status: 404 });
  // A new upload has a new hash; rebuild at most once a minute when one is not known yet.
  if (!index.has(hash) && Date.now() - builtAt > 60_000) await rebuild();
  const dataUrl = index.get(hash);
  const match = dataUrl?.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  return new Response(Buffer.from(match[2], "base64"), {
    headers: { "content-type": match[1], "cache-control": "public, max-age=31536000, immutable" },
  });
}
