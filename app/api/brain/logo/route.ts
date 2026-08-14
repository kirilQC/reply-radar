// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A client's logo, proxied out of the private repo.
 *
 * An `<img src>` cannot reach `raw.githubusercontent.com` for a private repository — the browser has
 * no token and putting one in a URL would publish it. So the bytes come back through here, which is
 * the only reason this route exists.
 *
 * Cached hard. A logo changes when a client rebrands, which is roughly never, and the alternative is
 * eighteen GitHub requests every time somebody opens the tab.
 */
import { NextResponse } from "next/server";
import { brainConfigured, brainRaw } from "../../../lib/brain";

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  gif: "image/gif",
};

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  // An allowlist of image extensions, not a check for `..`. This route returns raw bytes with a
  // content type attached, so the extension is the only thing deciding how a browser treats the
  // response — anything outside this list must not be reachable through it.
  if (!path.startsWith("clients/") || !TYPES[extension]) {
    return NextResponse.json({ ok: false, error: "That is not a logo." }, { status: 400 });
  }
  if (!brainConfigured()) return NextResponse.json({ ok: false, error: "The QC Brain is not connected." }, { status: 503 });

  try {
    const bytes = await brainRaw(path);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": TYPES[extension],
        "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch {
    // A missing logo is not an error worth a red box — the page falls back to the monogram, and a 404
    // is what tells the browser to stop asking.
    return new NextResponse(null, { status: 404 });
  }
}
