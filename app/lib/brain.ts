/**
 * Reading and writing the QC Brain, which is a private GitHub repository.
 *
 * ── What the brain is ───────────────────────────────────────────────────────────────────────────
 * `jsbiv18/qc-growth-os` is a few hundred markdown files that every QC person points their Claude
 * Code at: what each client sells, who they sell to, how we talk to them, what we have run and what
 * we learned. It is the shared memory of the agency, and it is genuinely good — but it lives in a
 * GitHub file tree, which is a terrible reading surface for anyone who does not already know where
 * things are. This module is what lets an app read it.
 *
 * ── Why the API and not a checkout ──────────────────────────────────────────────────────────────
 * There is no git on a Vercel function and no second repo in the bundle, so the GitHub API is the
 * only reachable copy — the same reasoning as `app/api/releases`, and the same headers. The
 * difference that matters is that this repo is *private*, so the token is not an optional
 * rate-limit lift here; without it every call is a 404. GitHub returns 404 rather than 403 for a
 * private repo you cannot see, which is deliberate on their part and confusing on ours, so that
 * case is translated into a sentence naming the likely cause.
 *
 * ── Caching, and why the tree is cached far longer than a file ──────────────────────────────────
 * Two different things are being fetched. The tree is one request that returns every path in the
 * repo, and it is what the client index, the search and the navigation are all built from — so it
 * is fetched once and held. A file's contents are fetched per view and held briefly, because
 * somebody who has just edited a page will reload it, and showing them the version they replaced
 * would read as a failed save.
 *
 * Both caches are per-instance and lost on a cold start, which is the correct amount of
 * sophistication: the cost of a miss is one GitHub request out of five thousand an hour.
 *
 * ── Writes ─────────────────────────────────────────────────────────────────────────────────────
 * Writes go through the Contents API, which requires the SHA of the file being replaced. That is
 * not a formality — it is optimistic locking, and it is the only thing standing between two people
 * editing the same client brief and one of them silently losing their work. A stale SHA comes back
 * as a 409 and is surfaced as "someone else changed this", not as a generic failure.
 */

/** The brain itself. One repo, hard-coded, because there is exactly one and there will not be two. */
export const BRAIN_REPO = "jsbiv18/qc-growth-os";
export const BRAIN_URL = `https://github.com/${BRAIN_REPO}`;

const API = "https://api.github.com";
/** The tree changes when someone adds a file, which is a few times a day at most. */
const TREE_CACHE_MS = 5 * 60_000;
/** Contents are cached only long enough to survive a page's own re-fetches. */
const FILE_CACHE_MS = 30_000;
/** The search corpus is expensive to build and rarely wrong, so it is held far longer. */
const CORPUS_CACHE_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

export type BrainFile = { path: string; sha: string; size: number };
export type BrainDoc = { path: string; sha: string; text: string; url: string };

let treeCache: { expires: number; files: BrainFile[] } | null = null;
const fileCache = new Map<string, { expires: number; doc: BrainDoc }>();
let corpusCache: { expires: number; docs: BrainDoc[] } | null = null;

/**
 * The token, and the one piece of setup this feature needs.
 *
 * `BRAIN_GITHUB_TOKEN` is preferred over the existing `GITHUB_TOKEN` because the two are not the
 * same job: `GITHUB_TOKEN` is an optional rate-limit lift on a public repo, and if someone sets it
 * to a token without access to the brain, silently falling back to it would turn a missing
 * configuration into a confusing 404. It is still accepted as a fallback, since one token with
 * access to both is a perfectly reasonable setup.
 */
const token = () => (process.env.BRAIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();

export const brainConfigured = () => token().length > 0;

const headers = (extra: Record<string, string> = {}) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  Authorization: `Bearer ${token()}`,
  ...extra,
});

/**
 * Every GitHub failure, translated into something a person could act on.
 *
 * A 404 on a private repo means the token cannot see it, which is either a missing token or one
 * without `Contents` access, and saying "GitHub returned 404" would send someone looking for a
 * deleted file that is sitting right there.
 */
async function github(path: string, init?: RequestInit) {
  if (!brainConfigured()) {
    throw new Error("The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN to a GitHub token with read access to the repo.");
  }
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: headers((init?.headers as Record<string, string>) ?? {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (response.status === 404) {
    throw new Error("GitHub could not find that. If this is everything rather than one file, the token probably cannot see the repo.");
  }
  if (response.status === 409) {
    throw new Error("Someone else changed this file since you opened it. Reload to get their version before saving yours.");
  }
  if (response.status === 401 || response.status === 403) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    throw new Error(remaining === "0" ? "GitHub's hourly request limit is used up. It resets within the hour." : "GitHub refused the token. It may have expired or lost access to the repo.");
  }
  if (!response.ok) throw new Error(`GitHub returned ${response.status}.`);
  return response.json();
}

/**
 * Every file in the repo, in one request.
 *
 * `?recursive=1` is the whole reason this is affordable — the alternative is walking the tree a
 * directory at a time, which for seventeen clients with nested `account/`, `feeds/` and `strategy/`
 * folders is upwards of a hundred round trips to draw one index page.
 *
 * GitHub truncates this response past roughly 100,000 entries. The brain is in the hundreds, so the
 * flag is checked rather than handled: if it ever trips, the honest thing is to say the list is
 * incomplete rather than to quietly render a partial repo as if it were the whole one.
 */
export async function brainTree(): Promise<BrainFile[]> {
  if (treeCache && treeCache.expires > Date.now()) return treeCache.files;
  const data = await github(`/repos/${BRAIN_REPO}/git/trees/HEAD?recursive=1`);
  const rows = Array.isArray((data as Record<string, unknown>)?.tree) ? ((data as Record<string, unknown>).tree as unknown[]) : [];
  if ((data as Record<string, unknown>)?.truncated === true) {
    throw new Error("The repository is too large to list in one request. This needs paging before the index can be trusted.");
  }
  const files = rows
    .map((row) => (row ?? {}) as Record<string, unknown>)
    .filter((row) => row.type === "blob")
    .map((row) => ({ path: String(row.path ?? ""), sha: String(row.sha ?? ""), size: Number(row.size ?? 0) }))
    // `.git` internals cannot appear here, but dotfiles and the built site can, and neither is
    // content anyone is looking for.
    .filter((file) => file.path && !file.path.startsWith("site/") && !file.path.endsWith(".DS_Store"));
  treeCache = { expires: Date.now() + TREE_CACHE_MS, files };
  return files;
}

/** Drops the cached tree, so a write is visible on the next read rather than up to five minutes later. */
export const forgetBrainTree = () => {
  treeCache = null;
  corpusCache = null;
};

/**
 * One file's text and the SHA needed to replace it.
 *
 * The SHA is returned to the caller and travels out to the browser and back on save. That is what
 * makes concurrent editing safe: the save is refused if the file moved underneath it, rather than
 * overwriting whatever arrived in between.
 *
 * Base64 rather than the `raw` media type because the Contents API gives the SHA and the content in
 * the same response, and the raw endpoint gives only the content — which would mean two requests to
 * open one file, every time.
 */
export async function brainFile(path: string): Promise<BrainDoc> {
  const cached = fileCache.get(path);
  if (cached && cached.expires > Date.now()) return cached.doc;
  const data = (await github(`/repos/${BRAIN_REPO}/contents/${encodePath(path)}`)) as Record<string, unknown>;
  if (Array.isArray(data)) throw new Error(`${path} is a folder, not a file.`);
  const doc: BrainDoc = {
    path,
    sha: String(data.sha ?? ""),
    text: decode(String(data.content ?? ""), String(data.encoding ?? "base64")),
    url: `${BRAIN_URL}/blob/main/${path}`,
  };
  fileCache.set(path, { expires: Date.now() + FILE_CACHE_MS, doc });
  return doc;
}

/**
 * Several files at once, for search and for anything that reads a whole client.
 *
 * Capped concurrency rather than a bare `Promise.all` over an unbounded list: forty simultaneous
 * requests to GitHub from one function invocation is how a token starts getting secondary rate
 * limited, which is a temporary ban rather than a slowdown.
 */
export async function brainFiles(paths: string[], concurrency = 8): Promise<BrainDoc[]> {
  const queue = [...paths];
  const done: BrainDoc[] = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      // One unreadable file must not take the search down with it.
      try {
        done.push(await brainFile(next));
      } catch {
        /* skipped */
      }
    }
  });
  await Promise.all(workers);
  return done;
}

/**
 * Every readable document in the repo, held in memory, so search can be done in-process.
 *
 * ── Why not GitHub's code search ────────────────────────────────────────────────────────────────
 * `/search/code` is one request instead of three hundred, and it was the obvious choice until the
 * details: it is rate limited to ten requests a minute, it indexes on GitHub's own schedule so a file
 * saved a minute ago is not findable, and its ranking is tuned for source code rather than prose. A
 * search that silently cannot find what someone just wrote is worse than a slow one.
 *
 * ── What this costs ────────────────────────────────────────────────────────────────────────────
 * The repo is a few hundred markdown files totalling a couple of megabytes, which is small enough to
 * hold and cheap enough to fetch: at eight in flight it is a few seconds, once, and then every
 * subsequent search is instant and works on the exact current text. The first search after a cold
 * start pays for all of them.
 *
 * This is only viable because the brain is small. If it ever reaches thousands of files this has to
 * become a real index, and the honest signal for that will be this function getting slow.
 */
export async function brainCorpus(paths: string[]): Promise<BrainDoc[]> {
  if (corpusCache && corpusCache.expires > Date.now()) return corpusCache.docs;
  const docs = await brainFiles(paths, 8);
  corpusCache = { expires: Date.now() + CORPUS_CACHE_MS, docs };
  return docs;
}

/**
 * When each path was last touched, for the staleness view.
 *
 * This is one request per path, which is why it is only ever asked for a handful at a time — the
 * client index asks about the six or seven documents that make up a client's skeleton, not about
 * all three hundred files in the repo.
 */
export async function brainLastTouched(paths: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  await Promise.all(
    paths.slice(0, 24).map(async (path) => {
      try {
        const rows = (await github(`/repos/${BRAIN_REPO}/commits?per_page=1&path=${encodeURIComponent(path)}`)) as unknown[];
        const commit = ((rows?.[0] ?? {}) as Record<string, unknown>).commit as Record<string, unknown> | undefined;
        const date = ((commit?.author ?? {}) as Record<string, unknown>).date;
        if (date) found.set(path, String(date));
      } catch {
        /* a missing date just means the column is blank */
      }
    }),
  );
  return found;
}

/**
 * Saves a file, on a branch, as a pull request — never straight onto `main`.
 *
 * This is the single most consequential decision in the module and it is worth being explicit about.
 * Every person at QC has their Claude Code pointed at this repo, so a bad edit does not affect one
 * reader — it silently becomes the shared truth for everybody, and nothing about a wrong ICP
 * announces itself. A pull request costs one click to merge and makes every change reviewable,
 * attributable and revertible. The screen calls it "propose", because that is what it is.
 *
 * The branch name carries the path and a timestamp, so two people editing different files never
 * collide and the same person editing twice gets two branches rather than a confusing force-update.
 */
export async function proposeBrainEdit({
  path,
  text,
  sha,
  summary,
  author = "QC Brain",
}: {
  path: string;
  text: string;
  sha: string;
  summary: string;
  author?: string;
}): Promise<{ url: string; number: number; branch: string }> {
  const base = (await github(`/repos/${BRAIN_REPO}`)) as Record<string, unknown>;
  const baseBranch = String(base.default_branch || "main");
  const head = (await github(`/repos/${BRAIN_REPO}/git/ref/heads/${baseBranch}`)) as Record<string, unknown>;
  const baseSha = String(((head.object ?? {}) as Record<string, unknown>).sha ?? "");

  const branch = `brain/${slug(path)}-${Date.now().toString(36)}`;
  await github(`/repos/${BRAIN_REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });

  await github(`/repos/${BRAIN_REPO}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: summary,
      content: encode(text),
      branch,
      committer: { name: author, email: "brain@qcgrowth.com" },
      // The SHA of the file as it was when it was opened, and omitted entirely when creating one.
      // GitHub rejects the write if it has moved, which is the whole point — see the note at the top
      // of this file. An empty string is not the same as absent here: it is rejected as malformed.
      ...(sha ? { sha } : {}),
    }),
  });

  const pull = (await github(`/repos/${BRAIN_REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: summary,
      head: branch,
      base: baseBranch,
      body: `Proposed from Reply Radar's QC Brain tab.\n\nFile: \`${path}\``,
    }),
  })) as Record<string, unknown>;

  fileCache.delete(path);
  return { url: String(pull.html_url ?? ""), number: Number(pull.number ?? 0), branch };
}

/**
 * Creating a file that does not exist yet, which is the same call without a SHA.
 *
 * Kept separate rather than making `sha` optional on the function above, because "replace this file,
 * and I know which version I am replacing" and "there is nothing here yet" are different intentions
 * and conflating them is how an accidental overwrite gets written as a one-character diff.
 */
export async function proposeBrainFile(input: { path: string; text: string; summary: string; author?: string }) {
  return proposeBrainEdit({ ...input, sha: "" });
}

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** A path, as a branch-name-safe fragment. */
const slug = (path: string) =>
  path.replace(/\.[a-z]+$/i, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).toLowerCase();

const decode = (content: string, encoding: string) =>
  encoding === "base64" ? Buffer.from(content, "base64").toString("utf8") : content;

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
