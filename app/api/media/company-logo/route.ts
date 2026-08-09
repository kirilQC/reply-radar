import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "");

function isPublicWebsite(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (host === "localhost" || host.endsWith(".local") || host === "0.0.0.0")
      return false;
    if (
      /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function attribute(tag: string, name: string) {
  return (
    tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? ""
  );
}

export async function GET(request: NextRequest) {
  const website = request.nextUrl.searchParams.get("website")?.trim() ?? "";
  const company = request.nextUrl.searchParams.get("company")?.trim() ?? "";
  if (!isPublicWebsite(website)) {
    return NextResponse.json(
      { ok: false, error: "Invalid public company website." },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(website, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "ReplyRadar/1.0 company-logo-resolver" },
    });
    if (!response.ok)
      throw new Error(`Company website returned ${response.status}.`);
    const html = await response.text();
    const companyKey = normalize(company);
    const candidates = [...html.matchAll(/<img\b[^>]*>/gi)]
      .map(([tag]) => {
        const srcset =
          attribute(tag, "srcset").split(",")[0]?.trim().split(/\s+/)[0] ?? "";
        const source =
          attribute(tag, "src") || attribute(tag, "data-src") || srcset;
        if (!source || source.startsWith("data:")) return null;
        let url: URL;
        try {
          url = new URL(source, response.url);
        } catch {
          return null;
        }
        if (!["http:", "https:"].includes(url.protocol)) return null;
        const evidence =
          `${attribute(tag, "alt")} ${attribute(tag, "class")} ${attribute(tag, "id")} ${url.pathname}`.toLowerCase();
        const normalizedEvidence = normalize(evidence);
        let score = 0;
        if (companyKey && normalizedEvidence.includes(companyKey)) score += 10;
        if (/logo|brand/.test(evidence)) score += 6;
        if (/header|nav/.test(evidence)) score += 2;
        if (/icon|favicon|avatar/.test(evidence)) score -= 3;
        return { url: url.toString(), score };
      })
      .filter((candidate): candidate is { url: string; score: number } =>
        Boolean(candidate),
      )
      .sort((a, b) => b.score - a.score);

    if (!candidates[0] || candidates[0].score < 6) {
      return NextResponse.json(
        { ok: false, error: "No reliable official company logo found." },
        { status: 404 },
      );
    }
    return NextResponse.redirect(candidates[0].url, {
      status: 307,
      headers: {
        "Cache-Control":
          "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Logo lookup failed.",
      },
      { status: 502 },
    );
  }
}
