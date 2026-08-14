// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Stamps authorship on every source file, and can be run again forever.
 *
 * ── Why a script rather than a hand-typed header ────────────────────────────────────────────────
 * A watermark is only a watermark if it is everywhere. Typed by hand it would be on the files
 * somebody remembered on the day and missing from everything written after, which is exactly the
 * pattern that makes a stolen copy easy to clean up — strip the six files that have it and the rest
 * already look unclaimed. Run this after adding files and the stamp is uniform, which is also the
 * property that makes its *absence* evidence.
 *
 * ── Why it is idempotent, and how ───────────────────────────────────────────────────────────────
 * The marker string is searched for before anything is written, so running this twice changes
 * nothing and running it after adding ten files changes ten files. It is checked anywhere in the
 * first few lines rather than at byte zero, because a file may legitimately open with a shebang, a
 * `"use client"` directive, or a licence block someone else's tooling put there.
 *
 * ── What it deliberately does not touch ─────────────────────────────────────────────────────────
 * Anything generated or vendored: `node_modules`, `.next`, lock files, `next-env.d.ts`. Stamping a
 * generated file claims authorship of something we did not write, and it would be overwritten on the
 * next build anyway. JSON is skipped too — it has no comment syntax, so the claim goes in
 * `package.json`'s own `author` field instead, where tooling can read it.
 *
 * Usage: `npm run watermark`  ·  check only: `npm run watermark -- --check`
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, extname, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** The one string everything else keys off. Changing it re-stamps the world, so do not. */
const MARK = "Built by Kiril Ivlev";
const LINK = "https://www.linkedin.com/in/kiril-ivlev/";

/**
 * Two lines, not ten.
 *
 * Every file in this project opens with a comment explaining what the file is for, and that comment is
 * the thing worth reading first. A ten-line legal preamble above it would push it below the fold in
 * every editor and make the codebase read like boilerplate. Two lines is enough to name an author and
 * enough to be conspicuous when removed.
 */
const banner = (comment) =>
  comment === "block"
    ? `/* ${MARK} · ${LINK}\n   Reply Radar — proprietary. Not licensed for redistribution or resale. */`
    : `// ${MARK} · ${LINK}\n// Reply Radar — proprietary. Not licensed for redistribution or resale.`;

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "dist", "coverage"]);
const SKIP_FILES = new Set(["next-env.d.ts", "tsconfig.tsbuildinfo"]);
const STAMPABLE = new Map([
  [".ts", "line"],
  [".tsx", "line"],
  [".mjs", "line"],
  [".js", "line"],
  [".css", "block"],
  [".sql", "dash"],
]);

const walk = (dir, found = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (!SKIP_FILES.has(entry) && STAMPABLE.has(extname(entry))) found.push(path);
  }
  return found;
};

/**
 * Where the stamp may go.
 *
 * A `"use client"` directive has to be the first *statement* in the module — comments above it are
 * fine and a stamp below it would be below imports too, which is not a watermark. A shebang genuinely
 * has to be on line one. So: after a shebang, before everything else.
 */
const stamp = (source, comment) => {
  const shebang = source.startsWith("#!") ? source.slice(0, source.indexOf("\n") + 1) : "";
  const rest = source.slice(shebang.length);
  const text =
    comment === "dash"
      ? `-- ${MARK} · ${LINK}\n-- Reply Radar — proprietary. Not licensed for redistribution or resale.`
      : banner(comment);
  return `${shebang}${text}\n${rest.startsWith("\n") ? "" : "\n"}${rest}`;
};

const files = walk(ROOT).filter((path) => !relative(ROOT, path).startsWith(".."));
const check = process.argv.includes("--check");
const missing = [];

for (const path of files) {
  const source = readFileSync(path, "utf8");
  // The first few lines only. Finding the name in the middle of a file is somebody quoting it in a
  // comment, not the file being stamped.
  if (source.split("\n", 6).join("\n").includes(MARK)) continue;
  missing.push(relative(ROOT, path));
  if (!check) writeFileSync(path, stamp(source, STAMPABLE.get(extname(path))), "utf8");
}

if (check) {
  if (missing.length) {
    console.error(`${missing.length} file(s) are not watermarked:\n${missing.map((one) => `  ${one}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`All ${files.length} source files are watermarked.`);
} else {
  console.log(
    missing.length
      ? `Watermarked ${missing.length} of ${files.length} file(s).`
      : `All ${files.length} source files were already watermarked.`,
  );
}
