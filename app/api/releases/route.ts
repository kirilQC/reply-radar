// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The commit history of this repo, as a release log people can actually read.
 *
 * Every change to Reply Radar is one commit with a written subject line, so the history already *is*
 * the changelog — there is nothing to maintain by hand, and a hand-maintained one would drift the first
 * week anyway. This route turns it into three fields per entry: when, who, and what changed.
 *
 * ── Why GitHub and not the local repo ───────────────────────────────────────────────────────────
 * There is no git checkout on a Vercel function. The deployed bundle has no `.git`, so `git log` is not
 * an option even though it is the obvious one, and shelling out would fail in production while working
 * perfectly in development. GitHub's API is the only reachable copy of the history.
 *
 * ── Rate limiting is the failure to design for ──────────────────────────────────────────────────
 * Unauthenticated GitHub allows 60 requests an hour *per IP*, and Vercel's egress IPs are shared, so the
 * budget can be gone through no fault of ours. Two defences: the answer is cached for fifteen minutes so
 * an open admin tab costs almost nothing, and `GITHUB_TOKEN` is used when present to raise the ceiling to
 * 5,000/hour. Neither is required for this to work — the repo is public.
 *
 * When GitHub does say no, this returns `ok: false` with a reason. The panel then shows the repo link and
 * says why the list is missing, which is the honest outcome; an empty list would read as "no commits".
 */
import { NextResponse } from "next/server";

const REPO = "kirilQC/reply-radar";
/**
 * One page of history, revealed five at a time in the UI. A hundred is GitHub's per-page maximum and
 * far more than anyone pages through by hand, so it is fetched once rather than paginated — the commit
 * *count* below is the true total either way, so a short list never misrepresents the project's size.
 */
const HISTORY_LIMIT = 100;
const CACHE_MS = 15 * 60_000;

type Release = { sha: string; shortSha: string; date: string; author: string; summary: string; url: string };
type Payload = { releases: Release[]; total: number };

let cache: { expires: number; payload: Payload } | null = null;

/**
 * Display names for committer identities.
 *
 * The git config on this repo commits as a bare "Kiril", which is not how the author's name should
 * appear in a log anyone else reads. Rewriting 220 commits to fix it would be worse than mapping it
 * here. Anyone not listed is shown exactly as git recorded them, so a future contributor needs no
 * change to this file to be named correctly.
 */
const DISPLAY_NAMES = new Map([["kiril", "Kiril Ivlev"]]);
const displayName = (name: string) => DISPLAY_NAMES.get(name.trim().toLowerCase()) ?? name.trim();

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const githubHeaders = () => {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

/**
 * The total number of commits on the default branch.
 *
 * GitHub has no endpoint for this. The trick is to ask for one commit per page and read the page number
 * out of the `rel="last"` link — with one per page, the last page number *is* the commit count. Without
 * that header there is only one page, so the count is however many came back.
 */
async function commitCount(): Promise<number> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=1`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} counting commits.`);
  const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(response.headers.get("link") ?? "");
  if (last) return Number(last[1]);
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows.length : 0;
}

async function history(): Promise<Release[]> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/commits?per_page=${HISTORY_LIMIT}`, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} listing commits.`);
  const rows = await response.json().catch(() => []);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const commit = object(object(row).commit);
    const author = object(commit.author);
    const sha = String(object(row).sha ?? "");
    // The subject line is the summary. Bodies on this repo run to paragraphs of reasoning, which is
    // the right place for it and the wrong thing to put in a list of five.
    const [subject = ""] = String(commit.message ?? "").split("\n");
    return {
      sha,
      shortSha: sha.slice(0, 7),
      date: String(author.date ?? ""),
      author: displayName(String(author.name ?? "")),
      summary: subject.trim(),
      url: `https://github.com/${REPO}/commit/${sha}`,
    };
  }).filter((release) => release.sha && release.summary);
}

export async function GET() {
  if (cache && cache.expires > Date.now()) {
    return NextResponse.json({ ok: true, repoUrl: `https://github.com/${REPO}`, ...cache.payload });
  }
  try {
    const [releases, total] = await Promise.all([history(), commitCount()]);
    const payload: Payload = { releases, total };
    cache = { expires: Date.now() + CACHE_MS, payload };
    return NextResponse.json({ ok: true, repoUrl: `https://github.com/${REPO}`, ...payload });
  } catch (error) {
    // The repo link is returned even on failure: it is the one part of this panel that is useful
    // when GitHub is unreachable, and it needs no API call to be correct.
    return NextResponse.json(
      {
        ok: false,
        repoUrl: `https://github.com/${REPO}`,
        error: error instanceof Error ? error.message : "The commit history could not be loaded.",
      },
      { status: 502 },
    );
  }
}
