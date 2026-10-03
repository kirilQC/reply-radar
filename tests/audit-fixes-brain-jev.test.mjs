// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Audit fixes across the QC Brain, the help bubble and Jev. The shared helpers are pure and asserted
 * directly; the TypeScript routes and pages are held to their source, the way the other route tests are.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeCsvBytes, duplicateOf, parseCsv, urlKey } from "../shared/jev.mjs";
import { linkedinProfileUrl } from "../shared/enrich.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("urlKey folds scheme, www, case, port, query and trailing slash into one key", () => {
  for (const raw of ["https://www.Acme.com/", "acme.com", "http://acme.com:443", "WWW.ACME.COM?utm=x"]) assert.equal(urlKey(raw), "acme.com");
  for (const raw of ["https://uk.linkedin.com/in/ada/", "www.linkedin.com/in/ada", "linkedin.com/in/Ada?trk=1#x"]) {
    assert.equal(urlKey(raw), "linkedin.com/in/ada");
  }
  assert.equal(urlKey(""), "");
});

test("the same person behind a scheme-less www URL is a duplicate, not a second charged row", () => {
  const dupes = duplicateOf([
    { linkedin: "https://www.linkedin.com/in/ada/", name: "Ada", company: "X" },
    { linkedin: "www.linkedin.com/in/ADA", name: "Ada L", company: "X" },
    { linkedin: "https://linkedin.com/in/bob", name: "Bob", company: "X" },
  ]);
  assert.deepEqual([...dupes.entries()], [[1, 0]]);
});

test("decodeCsvBytes reads Excel's UTF-16 and Windows-1252 saves, and UTF-8 with or without a BOM", () => {
  const utf8 = new TextEncoder().encode("name\nCafé");
  assert.equal(decodeCsvBytes(utf8), "name\nCafé");
  assert.equal(decodeCsvBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8])), "name\nCafé");
  // "name\nCafé’" in Windows-1252: é is 0xE9 and ’ is 0x92, neither valid UTF-8 on its own.
  assert.equal(decodeCsvBytes(Uint8Array.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9, 0x92])), "name\nCafé’");
  const le = Uint8Array.from([0xff, 0xfe, ...[..."a,é"].flatMap((c) => [c.charCodeAt(0), 0])]);
  assert.equal(decodeCsvBytes(le), "a,é");
  const be = Uint8Array.from([0xfe, 0xff, ...[..."a,é"].flatMap((c) => [0, c.charCodeAt(0)])]);
  assert.equal(decodeCsvBytes(be), "a,é");
  // No mark, but NULs every other byte: UTF-16 all the same.
  assert.equal(decodeCsvBytes(Uint8Array.from([..."a,b\n1,2"].flatMap((c) => [c.charCodeAt(0), 0]))), "a,b\n1,2");
  assert.deepEqual(parseCsv(decodeCsvBytes(le)).headers, ["a", "é"]);
  assert.equal(decodeCsvBytes(new ArrayBuffer(0)), "");
});

test("a malformed % escape in a LinkedIn URL no longer throws and ends enrichment", () => {
  assert.doesNotThrow(() => linkedinProfileUrl("https://www.linkedin.com/in/ada-100%-growth"));
  assert.equal(linkedinProfileUrl("https://www.linkedin.com/in/ada%E2"), "https://www.linkedin.com/in/ada%E2/");
  assert.equal(linkedinProfileUrl("https://www.linkedin.com/in/j%C3%B6rg"), "https://www.linkedin.com/in/jörg/");
});

test("brain links encode each path segment, everywhere a GitHub file link is built", () => {
  const brain = read("app/lib/brain.ts");
  assert.match(brain, /export const brainBlobUrl = \(path: string, branch = "main"\) => `\$\{BRAIN_URL\}\/blob\/\$\{branch\}\/\$\{encodePath\(path\)\}`/);
  for (const file of ["app/lib/brain.ts", "app/api/brain/file/route.ts", "app/api/brain/search/route.ts", "app/api/brain/skills/route.ts", "app/lib/assistant-tools.ts", "app/lib/dnc.ts"]) {
    assert.doesNotMatch(read(file), /`\$\{BRAIN_URL\}\/blob\/(main|HEAD)\//, file);
  }
});

test("a file over 1 MB is read through the raw endpoint instead of rendering empty", () => {
  const brain = read("app/lib/brain.ts");
  assert.match(brain, /data\.encoding === "none"/);
  assert.match(brain, /await brainRaw\(path\)/);
});

test("a failed proposal removes its branch, and only a brain/ branch ref can ever be removed", () => {
  const brain = read("app/lib/brain.ts");
  assert.match(brain, /catch \(error\) \{[\s\S]*discardProposalBranch\([\s\S]*throw error;/);
  const cleanup = read("app/lib/brain-branches.ts");
  assert.match(cleanup, /if \(!\/\^brain\\\/\[a-z0-9-\]\+\$\/\.test\(branch\)\) return;/);
  assert.match(cleanup, /\/git\/refs\/heads\/\$\{branch\}/);
  assert.doesNotMatch(cleanup, /\/contents\//);
});

test("generating an ICP never writes the brain; it is proposed as a pull request on request", () => {
  const route = read("app/api/brain/icp/route.ts");
  assert.doesNotMatch(route, /writeBrainFile/);
  assert.match(route, /body\.propose === true/);
  assert.match(route, /proposeBrainEdit\(/);
});

test("an SVG logo is served with a script-free policy and nosniff", () => {
  const route = read("app/api/brain/logo/route.ts");
  assert.match(route, /"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'"/);
  assert.match(route, /"x-content-type-options": "nosniff"/);
});

test("the Scout link in a help answer survives parentheses in the question", () => {
  const route = read("app/api/help/ask/route.ts");
  assert.match(route, /encodeURIComponent\(question\)\.replace\(\/\\\(\/g, "%28"\)\.replace\(\/\\\)\/g, "%29"\)/);
});

test("the ICP sheet's Close abandons the run, and the brain page drops late responses", () => {
  const page = read("app/qc-brain/BrainApp.tsx");
  assert.match(page, /if \(run !== icpRun\.current\) return;/);
  assert.match(page, /const closeIcp = useCallback\(\(\) => \{\s*icpRun\.current \+= 1;\s*icpAbort\.current\?\.abort\(\);/);
  assert.match(page, /if \(wantedKey\.current === key\) setDetail\(body\.client\)/);
  assert.match(page, /if \(wantedKey\.current === key\) setCampaigns\(body\.campaigns \?\? \[\]\)/);
  assert.match(page, /if \(showingPath\.current !== want\) return;/);
  // The warm walk waits while hidden and stops on unmount.
  assert.match(page, /document\.addEventListener\("visibilitychange", on\)/);
  assert.match(page, /return \(\) => \{\s*stopped = true;\s*wake\?\.\(\);/);
  // A truncated layout says so.
  assert.match(page, /layout\.truncated &&/);
});

test("Jev claims one job at a time before any await", () => {
  const page = read("app/jev/[slug]/page.tsx");
  for (const [name, job] of [["run", "run"], ["reviewWithClaude", "review"], ["reviewMaybes", "review"]]) {
    assert.match(page, new RegExp(`const ${name} = async \\([^)]*\\) => \\{\\s*if \\(activeJob\\.current\\) return;\\s*activeJob\\.current = "${job}";`), name);
  }
  assert.match(page, /decodeCsvBytes\(await f\.arrayBuffer\(\)\)/);
});

test("help screenshots are capped so the encoded request stays under the platform's body limit", () => {
  const widget = read("app/components/HelpWidget.tsx");
  const max = Number(widget.match(/const MAX_BYTES = ([\d_]+);/)[1].replace(/_/g, ""));
  // Base64 plus the data-URL prefix must fit the feedback route's 4,000,000-character cap.
  assert.ok(Math.ceil(max / 3) * 4 + 40 <= 4_000_000);
  assert.match(widget, /total \+ shot\.data\.length > MAX_TOTAL_CHARS/);
});
