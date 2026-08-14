/**
 * Turning a repository of files into a picture of the agency.
 *
 * ── The problem this solves ─────────────────────────────────────────────────────────────────────
 * The QC Brain is 300-odd markdown files and there is almost no metadata in it — thirteen files
 * carry YAML frontmatter and the rest carry none. So there is nothing to query and no schema to read
 * from. What there *is* is a convention: `clients/template/` prescribes a skeleton, and every client
 * folder is some approximation of it.
 *
 * That makes the folder layout the only machine-readable thing in the repo, and this module is what
 * reads it. Everything here is derived from paths — which is why it is plain `.mjs` with no network
 * and no GitHub types, and why it can be tested exhaustively without a token.
 *
 * ── Why a fixed skeleton rather than showing whatever is there ───────────────────────────────────
 * Simply listing each client's files would rebuild the file tree with nicer fonts, and the file tree
 * is the thing that is hard to use. The skeleton is what makes the surface answer questions instead:
 * every client has the same seven slots in the same order, so "who have we not written personas
 * for" is visible at a glance rather than being seventeen folders to open. A missing document is
 * information, and it can only be shown if something knows the document was expected.
 *
 * Anything outside the skeleton is still surfaced — the big clients have far more than the template
 * and none of it is junk — it is just grouped underneath rather than given equal billing.
 */

/**
 * The documents every client is expected to have, in reading order.
 *
 * The order is deliberate and it is not the alphabetical order the file system gives: it runs from
 * what the client is, to who they sell to, to how we speak, to what we are doing about it. Someone
 * opening a client they have never worked on should be able to read straight down.
 *
 * `aliases` exist because the convention drifted before it settled. `strategy/current-engagement.md`
 * is the template's name, but some clients have `strategy/engagement.md`, and treating those as two
 * different documents would report a missing file next to a present one that says the same thing.
 */
export const CLIENT_DOCS = [
  { key: "brief", label: "Brief", path: "README.md", aliases: ["readme.md", "overview.md"], blurb: "What this client is and what we are doing for them" },
  { key: "icp", label: "ICP", path: "account/icp.md", aliases: ["account/ideal-customer.md"], blurb: "Who they sell to — firmographics, pains, triggers" },
  { key: "personas", label: "Personas", path: "account/personas.md", aliases: ["account/persona.md"], blurb: "The buyers, and the angle for each" },
  { key: "voice", label: "Voice", path: "account/voice.md", aliases: ["account/tone.md"], blurb: "How we write for them, and what never to say" },
  { key: "engagement", label: "Engagement", path: "strategy/current-engagement.md", aliases: ["strategy/engagement.md", "strategy/current.md"], blurb: "Live campaigns, open items, what we have learned" },
  { key: "crm", label: "Pipeline", path: "feeds/crm-snapshot.md", aliases: ["feeds/pipeline-tracker.md", "feeds/crm.md"], blurb: "Meetings booked, open accounts, where deals stand" },
  { key: "dnc", label: "Do not contact", path: "account/dnc.md", aliases: ["account/do-not-contact.md"], blurb: "Accounts and people who are off limits" },
];

/** Folders under `clients/` that are not clients. */
const NOT_CLIENTS = new Set(["template", "dnc", "_template"]);

/**
 * How long a document can go untouched before it is worth mentioning.
 *
 * Ninety days is not a rule about how often anything must be rewritten — an ICP that is still right
 * after a year is a good ICP. It is the point past which nobody can remember whether it was
 * reviewed, which is the actual question being answered.
 */
export const STALE_DAYS = 90;

const lower = (value) => String(value ?? "").toLowerCase();

/** `clients/willow/account/icp.md` → `willow`, and nothing for anything outside `clients/`. */
export function clientOf(path) {
  const match = /^clients\/([^/]+)\//.exec(String(path ?? ""));
  if (!match) return "";
  return NOT_CLIENTS.has(lower(match[1])) ? "" : match[1];
}

/**
 * `bluevia-health` → `Bluevia Health`, but `Hemaptics` is left alone.
 *
 * Folder names are inconsistent — most are lower-case and hyphenated, a couple are already
 * capitalised — and title-casing something that is already a proper noun would turn `Hemaptics`
 * into `Hemaptics` at best and mangle it at worst. So a name that already contains a capital is
 * trusted as written.
 */
export function clientLabel(slug) {
  const name = String(slug ?? "");
  if (/[A-Z]/.test(name)) return name;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A client's monogram, for when there is no logo file.
 *
 * Two letters from two words, one from one — "Bluevia Health" is BH and "Willow" is W. Initials of a
 * name people already know are recognisable at a glance in a way that a generic placeholder is not,
 * and the grid is a wall of eighteen tiles that has to be scannable without reading.
 */
export function clientInitials(label) {
  const words = String(label ?? "")
    .split(/[\s\-_]+/)
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * A colour for that monogram, derived from the name.
 *
 * Derived rather than stored, because a colour nobody chose still has to be the *same* colour every
 * time — a tile that changes hue between page loads reads as a bug, and asking someone to pick
 * eighteen colours to look at a repository is not a reasonable trade. The name is hashed to a hue and
 * the saturation and lightness are fixed, so every tile is a different colour and none of them fight
 * the page.
 */
export function clientHue(name) {
  const text = String(name ?? "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 360000;
  }
  return hash % 360;
}

const LOGO_NAMES = /^logo\.(png|jpg|jpeg|svg|webp|gif)$/i;

/**
 * A real logo, if somebody has put one in the client's folder.
 *
 * Nothing in the repo has one today. This exists so that the way to get a real logo onto the page is
 * to drop `logo.png` into `clients/<name>/` and commit it — which is how this team already works,
 * and which needs no upload screen, no storage and no second source of truth. Until then the monogram
 * stands in.
 */
export function clientLogoIn(paths, client) {
  const prefix = `clients/${client}/`;
  return (
    (Array.isArray(paths) ? paths : []).find((path) => path.startsWith(prefix) && LOGO_NAMES.test(path.slice(prefix.length))) ?? ""
  );
}

/** Every client in the repo, from the paths alone, in alphabetical order. */
export const clientsIn = (paths) =>
  [...new Set((Array.isArray(paths) ? paths : []).map(clientOf).filter(Boolean))].sort((a, b) =>
    clientLabel(a).localeCompare(clientLabel(b)),
  );

/**
 * Which of the expected documents a client actually has.
 *
 * Matching is case-insensitive and alias-aware, and it returns the *real* path rather than the
 * canonical one, because that is what has to be fetched and what has to be written back to. A slot
 * with no path is a document nobody has written, which is the thing worth showing.
 */
export function clientSkeleton(client, paths) {
  const mine = (Array.isArray(paths) ? paths : []).filter((path) => clientOf(path) === client);
  const prefix = `clients/${client}/`;
  const byRelative = new Map(mine.map((path) => [lower(path.slice(prefix.length)), path]));
  const claimed = new Set();

  const docs = CLIENT_DOCS.map((doc) => {
    const candidates = [doc.path, ...(doc.aliases ?? [])];
    const found = candidates.map((candidate) => byRelative.get(lower(candidate))).find(Boolean) ?? "";
    if (found) claimed.add(found);
    return { ...doc, found, present: Boolean(found) };
  });

  // Everything else the client has, which for the larger accounts is most of what is there: call
  // notes, lead lists, ad copy, deal context. Grouped by folder so it reads as sections rather than
  // as thirty loose files.
  const extras = mine.filter((path) => !claimed.has(path)).sort();
  return { client, label: clientLabel(client), docs, extras, groups: groupByFolder(extras, prefix) };
}

/**
 * Loose files, gathered under the folder they sit in.
 *
 * Files directly in the client root come back under an empty group name, which the UI renders
 * without a heading — a heading called "clients/willow" above two files would be noise.
 */
export function groupByFolder(paths, prefix = "") {
  const groups = new Map();
  for (const path of Array.isArray(paths) ? paths : []) {
    const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const cut = relative.lastIndexOf("/");
    const folder = cut === -1 ? "" : relative.slice(0, cut);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push({ path, name: relative.slice(cut + 1) });
  }
  return [...groups.entries()]
    .map(([folder, files]) => ({ folder, files }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/**
 * A human title for a file, for use in lists and search results.
 *
 * `feeds/calls/2026-07-22-h2-plan-greenfield-code-context.md` is unreadable at a glance and its
 * first heading is usually the real title, but the first heading requires having fetched the file.
 * This works from the path alone so a list of forty results costs nothing.
 */
export function fileTitle(path) {
  const name = String(path ?? "").split("/").pop() ?? "";
  const bare = name.replace(/\.[a-z0-9]+$/i, "");
  if (lower(bare) === "readme") {
    const parent = String(path).split("/").slice(-2, -1)[0] ?? "Overview";
    return `${clientLabel(parent)} overview`;
  }
  // A leading ISO date is metadata, not title, and it is already shown as the date.
  const dated = /^(\d{4}-\d{2}-\d{2})[-_](.+)$/.exec(bare);
  const words = (dated ? dated[2] : bare).replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The date a filename claims, for call notes and dated snapshots. `""` when there is none. */
export function fileDate(path) {
  const match = /(\d{4}-\d{2}-\d{2})/.exec(String(path ?? "").split("/").pop() ?? "");
  return match ? match[1] : "";
}

/**
 * What kind of thing a path is, which decides whether the app can show it at all.
 *
 * The brain is not purely markdown: there are lead lists as CSV, raw scrape output as JSONL, ad
 * creative as SVG, and onboarding decks as PDF. Rendering a JSONL file as text would paste four
 * thousand lines of JSON into a reading surface, so those are listed and linked to GitHub rather
 * than opened. Being able to *see that they exist* is most of the value; opening them is rare.
 */
export function fileKind(path) {
  const name = lower(path);
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "doc";
  if (name.endsWith(".csv") || name.endsWith(".tsv")) return "table";
  if (name.endsWith(".svg") || name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".gif")) return "image";
  if (name.endsWith(".pdf")) return "pdf";
  if (name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".yml") || name.endsWith(".yaml")) return "data";
  if (name.endsWith(".py") || name.endsWith(".sh") || name.endsWith(".mjs") || name.endsWith(".js")) return "script";
  return "other";
}

export const isReadable = (path) => fileKind(path) === "doc";

/**
 * Campaign codes mentioned in a document.
 *
 * This is the join between the brain and Reply Radar, and it is the one thing this surface can do
 * that neither GitHub nor the existing docs site can. QC names every campaign with a client code and
 * a number — CT003, SW019, W040 — and those codes are written throughout the strategy notes. Finding
 * them means a sentence about what we *intended* can sit next to what actually happened.
 *
 * The pattern is the same one `shared/campaign-code.mjs` uses to recognise a HeyReach campaign name,
 * because the join only works if both sides agree on what a code is: one to three letters, an
 * optional colon, two or three digits. Two guards keep it from firing on ordinary prose — the first
 * letter must be capitalised, and nothing alphanumeric may follow the digits. Without them `RFC1234`,
 * `COVID19` and `B2B` all read as campaigns.
 *
 * One digit is not enough, which is what keeps `H2 plan`, `Q4` and `SOC2` out. The remaining false
 * positives are things like `USD100`, and they are harmless by construction: the page only links a
 * code that matches a campaign that exists, so an invented one silently stays plain text.
 */
const CAMPAIGN_CODE = /\b([A-Z][A-Za-z]{0,2}):?(\d{2,3})(?![A-Za-z0-9])/g;

export function campaignCodesIn(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(CAMPAIGN_CODE)) {
    found.add(`${match[1].toUpperCase()}${match[2]}`);
  }
  return [...found].sort();
}

/**
 * How stale a date is, in whole days, and whether that is worth flagging.
 *
 * `null` for a document that has never existed — that is "missing", which the UI says differently
 * from "old", because they call for different actions.
 */
export function staleness(iso, now = Date.now()) {
  if (!iso) return { days: null, stale: false };
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { days: null, stale: false };
  const days = Math.max(0, Math.floor((now - then) / 86_400_000));
  return { days, stale: days >= STALE_DAYS };
}

/** `2026-05-02T…` → `3 months ago`, for a column where the exact day is never the point. */
export function agoLabel(iso, now = Date.now()) {
  const { days } = staleness(iso, now);
  if (days === null) return "";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 18) return months === 1 ? "1 month ago" : `${months} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/**
 * How complete a client's core context is, as a fraction.
 *
 * Deliberately counts only the skeleton and ignores the extras, because a client with thirty call
 * notes and no ICP is *less* ready than one with an ICP and nothing else, and a score that rewarded
 * volume would say the opposite. Do-not-contact is excluded from the denominator: most clients
 * legitimately have no DNC list, and counting its absence as a gap would permanently show every
 * client as incomplete, which trains people to ignore the number.
 */
export function coverage(skeleton) {
  const counted = (skeleton?.docs ?? []).filter((doc) => doc.key !== "dnc");
  const have = counted.filter((doc) => doc.present).length;
  return { have, total: counted.length, fraction: counted.length ? have / counted.length : 0 };
}

/**
 * A slash command, read as something a person could choose to run.
 *
 * ── Why the skills are worth a page of their own ────────────────────────────────────────────────
 * `.claude/commands/` is where the actual leverage in this repo lives: twenty-odd routines somebody
 * wrote once and everybody else can now run. The problem is that they are invisible — you find out a
 * command exists by someone mentioning it in Slack, and the ones scoped to a single client are the
 * least discoverable and the most useful.
 *
 * ── Reading them ────────────────────────────────────────────────────────────────────────────────
 * Some carry frontmatter with a `description`, most do not. So the description falls back to the
 * first real line of prose, which for these files is reliably a sentence saying what the command
 * does — headings, code fences and the frontmatter block are skipped to find it. Showing a filename
 * with no description would leave the catalogue no more useful than the folder listing it replaces.
 */
export function parseSkill(path, text) {
  const name = String(path ?? "").split("/").pop()?.replace(/\.md$/i, "") ?? "";
  const body = String(text ?? "");
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(body);
  const meta = front ? front[1] : "";
  const rest = front ? body.slice(front[0].length) : body;
  const described = /^description:\s*(.+)$/m.exec(meta);

  let blurb = described ? described[1].trim().replace(/^["']|["']$/g, "") : "";
  if (!blurb) {
    let fenced = false;
    for (const line of rest.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        fenced = !fenced;
        continue;
      }
      if (fenced || !trimmed || trimmed.startsWith("#") || trimmed.startsWith("<")) continue;
      blurb = trimmed.replace(/^[-*>]\s*/, "").replace(/\*\*|__|`/g, "");
      break;
    }
  }
  if (blurb.length > 180) blurb = `${blurb.slice(0, 180).trimEnd()}…`;

  // A command named for a client belongs to that client, which is how it reaches their page. The
  // check is on the leading segment so `willow-weekly` matches and `weekly-review` does not match a
  // client called `review`.
  return { name, path, command: `/${name}`, blurb, lines: rest.split("\n").length };
}

/** Which client a command is scoped to, given the clients that exist. `""` for a general one. */
export function skillClient(name, clients) {
  const bare = lower(name);
  return (Array.isArray(clients) ? clients : []).find((client) => bare.startsWith(`${lower(client)}-`) || bare === lower(client)) ?? "";
}

/**
 * The top-level areas of the repo that are not clients.
 *
 * Named and described here rather than in the page, because "what is `verticals/` for" is exactly
 * the knowledge a new joiner does not have and the folder name does not supply.
 */
export const BRAIN_AREAS = [
  { key: "company", label: "Company", prefix: "company/", blurb: "How QC runs — process, positioning, internal playbooks" },
  { key: "wiki", label: "Playbooks", prefix: "wiki/", blurb: "Sales motion, SOPs, prompts and the team handbook" },
  { key: "verticals", label: "Verticals", prefix: "verticals/", blurb: "Market research and messaging by industry" },
  { key: "commands", label: "Skills", prefix: ".claude/commands/", blurb: "The slash commands Claude can run against the brain" },
];
