"use client";

/**
 * The QC Brain: a front end for the repository the whole agency thinks out of.
 *
 * ── What this replaces ──────────────────────────────────────────────────────────────────────────
 * `jsbiv18/qc-growth-os` is where QC keeps everything it knows — what each client sells, who they
 * sell to, how we write for them, what we ran and what we learned — and every person's Claude Code is
 * pointed at it. It works well for the people who wrote it and badly for everyone else, because
 * GitHub's file tree is a filing cabinet: it will show you three hundred filenames and never tell you
 * that a client has no ICP written, or that their voice guide has not been touched since March.
 *
 * So this is deliberately not a file browser with better fonts. Three things make it worth having:
 *
 *   1. Every client is shown against the same skeleton, so a *missing* document is as visible as a
 *      present one. That is the question people actually have and a file tree cannot answer it.
 *   2. Search that ranks a filename above a passing mention, because "willow icp" means one document
 *      and not the forty call notes that say the word Willow.
 *   3. The campaign codes in the prose are joined to live HeyReach figures. Nothing else can do this:
 *      the strategy lives in GitHub, the numbers live in HeyReach, and Reply Radar is the only place
 *      both are reachable at once. It is the reason this is a tab here rather than a better docs site.
 *
 * ── Editing ─────────────────────────────────────────────────────────────────────────────────────
 * Saving opens a pull request rather than committing. Everyone's assistant reads this repo, so a
 * wrong edit does not inconvenience one person — it quietly becomes what the whole team is told. The
 * button says "Propose", because that is what it does.
 *
 * ── State, and why a client has a URL anyway ────────────────────────────────────────────────────
 * One component with a `view` field rather than nested routes: the whole surface is a handful of
 * screens over one cached tree, and splitting it across routes would put a navigation and a re-fetch
 * behind every click for no gain.
 *
 * But a client with no address of their own cannot be linked to, and pasting a link into Slack is how
 * anybody here actually shares anything. So `/qc-brain/willow` is a real route rendering this same
 * component with `initialClient` set, and moving between screens keeps the address bar in step with
 * `history.pushState` — a URL you can copy, a back button that works, and still no navigation. The
 * address follows the screen; it does not drive it.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import Markdown from "../components/Markdown";
import { agoLabel, clientHue, clientInitials, fileKind, staleness } from "../../shared/brain-structure.mjs";

type Coverage = { have: number; total: number; fraction: number };
type IndexClient = { client: string; label: string; logo: string };
type Area = { key: string; label: string; prefix: string; blurb: string; files: number };
type Doc = { key: string; label: string; blurb: string; path: string; present: boolean; updated: string };
type Group = { folder: string; files: { path: string; name: string; title: string }[] };
type Workspace = { name: string; slug: string; connected: boolean; how: string };
type Fact = { label: string; value: string };
type ClientSkill = { command: string; blurb: string; path: string };
type ClientDetail = {
  client: string;
  label: string;
  logo: string;
  summary: string;
  facts: Fact[];
  briefPath: string;
  skills: ClientSkill[];
  files: number;
  workspace: Workspace | null;
  docs: Doc[];
  groups: Group[];
  coverage: Coverage;
};
type Campaign = { code: string; id: string; name: string; conversationsStarted: number; replies: number; replyRate: number };
type FileDoc = { path: string; kind: string; title: string; text: string; sha: string; url: string; codes: string[]; updated: string };
type Hit = { path: string; title: string; snippet: string; client: string; clientLabel: string; url: string };
type Skill = { name: string; path: string; command: string; blurb: string; client: string; clientLabel: string; url: string };

const ago = agoLabel as (iso: string, now?: number) => string;
const stale = staleness as (iso: string, now?: number) => { days: number | null; stale: boolean };
const kindOf = fileKind as (path: string) => string;
const initials = clientInitials as (label: string) => string;
const hue = clientHue as (name: string) => number;

const json = async (url: string) => {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!body?.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body;
};

export default function BrainApp({ initialClient = "" }: { initialClient?: string }) {
  // "client" is a client's home page and "doc" is reading one of their files. They were one screen
  // and are now two, because a home page that is really a document viewer with a tab strip on top
  // gives a client no place to put anything that is not a document — their campaign figures, what is
  // missing, how much there is.
  const [view, setView] = useState<"index" | "client" | "doc" | "area" | "skills" | "solo">(initialClient ? "client" : "index");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [clients, setClients] = useState<IndexClient[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [repoUrl, setRepoUrl] = useState("https://github.com/jsbiv18/qc-growth-os");

  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [area, setArea] = useState<{ label: string; blurb: string; groups: Group[] } | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);

  /**
   * The open document is keyed by its path rather than cleared when the path changes.
   *
   * Clearing it would mean writing state the instant a path is set, and the render that follows would
   * throw away the work of the one before it. Keeping the last-loaded document and only showing it
   * when it is the one that was asked for gets the same "no stale text on screen" guarantee out of a
   * comparison instead of a second render.
   */
  const [openPath, setOpenPath] = useState("");
  const [loaded, setLoaded] = useState<FileDoc | null>(null);
  const [failed, setFailed] = useState<{ path: string; message: string } | null>(null);
  const doc = loaded && loaded.path === openPath ? loaded : null;
  const docError = failed && failed.path === openPath ? failed.message : "";

  const [query, setQuery] = useState("");
  // Keyed by the query they answer, for the same reason the open document is keyed by its path: it
  // makes "these results are for what is currently typed" a comparison rather than a second render.
  const [answered, setAnswered] = useState<{ query: string; results: Hit[] }>({ query: "", results: [] });

  useEffect(() => {
    json("/api/brain/clients")
      .then((body) => {
        setClients(body.clients ?? []);
        setAreas(body.areas ?? []);
        if (body.repoUrl) setRepoUrl(body.repoUrl);
      })
      .catch((problem: Error) => setError(problem.message))
      .finally(() => setLoading(false));
  }, []);

  /** The address bar, moved to match the screen. No navigation: nothing here needs re-rendering. */
  const travel = useCallback((path: string) => {
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, []);

  /**
   * Fetching a client, without touching any other state.
   *
   * Separate from `showClient` because landing on `/qc-brain/willow` has to fetch without setting a
   * view — the view is already right — and writing state synchronously from a mount effect is the one
   * thing the compiler will not allow. Everything here lands in a promise callback.
   */
  const loadClient = useCallback((slug: string) => {
    json(`/api/brain/clients?client=${encodeURIComponent(slug)}`)
      .then((body) => setDetail(body.client))
      .catch((problem: Error) => setError(problem.message));
    // Campaign figures come from HeyReach and take seconds. Fetched alongside rather than before, so
    // the documents are readable while the numbers are still on their way.
    json(`/api/brain/campaigns?client=${encodeURIComponent(slug)}`)
      .then((body) => setCampaigns(body.campaigns ?? []))
      .catch(() => setCampaigns([]));
  }, []);

  const showClient = useCallback(
    (slug: string) => {
      if (!slug) return;
      setView("client");
      setDetail(null);
      setCampaigns([]);
      setOpenPath("");
      setError("");
      // No document is opened. The client's own page is the destination now, not a staging post on
      // the way to their brief.
      loadClient(slug);
    },
    [loadClient],
  );

  const openClient = useCallback(
    (slug: string) => {
      showClient(slug);
      if (slug) travel(`/qc-brain/${encodeURIComponent(slug)}`);
    },
    [showClient, travel],
  );

  const openArea = useCallback((prefix: string) => {
    setView("area");
    setArea(null);
    setOpenPath("");
    setError("");
    json(`/api/brain/clients?area=${encodeURIComponent(prefix)}`)
      .then((body) => setArea(body.area))
      .catch((problem: Error) => setError(problem.message));
  }, []);

  const openSkills = useCallback(() => {
    setView("skills");
    setOpenPath("");
    setError("");
    if (skills.length) return;
    json("/api/brain/skills")
      .then((body) => setSkills(body.skills ?? []))
      .catch((problem: Error) => setError(problem.message));
  }, [skills.length]);

  const showIndex = useCallback(() => {
    setView("index");
    setDetail(null);
    setArea(null);
    setOpenPath("");
    setError("");
  }, []);

  const home = useCallback(() => {
    showIndex();
    travel("/qc-brain");
  }, [showIndex, travel]);

  // Landing straight on a client's URL. The view is already "client"; only the data is missing.
  useEffect(() => {
    if (initialClient) loadClient(initialClient);
  }, [initialClient, loadClient]);

  /**
   * The back button, which is the whole reason for keeping the address in step.
   *
   * Only the directory and a client have addresses, so back from a document returns to the directory
   * rather than to the client — the breadcrumb is the way back up one level, and giving every opened
   * file a history entry would mean three clicks of Back to leave a client you skimmed.
   */
  useEffect(() => {
    const back = () => {
      const slug = window.location.pathname.replace(/^\/qc-brain\/?/, "");
      if (slug) showClient(decodeURIComponent(slug));
      else showIndex();
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, [showClient, showIndex]);

  // Whichever document is open, on whichever screen asked for it.
  useEffect(() => {
    if (!openPath) return;
    let current = true;
    json(`/api/brain/file?path=${encodeURIComponent(openPath)}`)
      .then((body) => {
        if (current) setLoaded(body as FileDoc);
      })
      .catch((problem: Error) => {
        if (current) setFailed({ path: openPath, message: problem.message });
      });
    return () => {
      current = false;
    };
  }, [openPath]);

  /**
   * Search runs on a pause, not a keystroke.
   *
   * The first query after a cold start pulls three hundred files into the server's memory, so firing
   * one per character would queue five of those before the word is finished. 320ms is long enough to
   * finish typing a word and short enough that it still feels like it is keeping up.
   */
  useEffect(() => {
    const wanted = query.trim();
    if (wanted.length < 2) return;
    const pending = window.setTimeout(() => {
      json(`/api/brain/search?q=${encodeURIComponent(wanted)}`)
        // A failed search is recorded against its query too, so the strip stops saying "Searching…"
        // forever when the request dies.
        .then((body) => setAnswered({ query: wanted, results: body.results ?? [] }))
        .catch(() => setAnswered({ query: wanted, results: [] }));
    }, 320);
    return () => window.clearTimeout(pending);
  }, [query]);

  const asked = query.trim();
  const searchOpen = asked.length >= 2;
  const searching = searchOpen && answered.query !== asked;
  const hits = answered.query === asked ? answered.results : [];
  const trail = useMemo(() => {
    const back = (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      home();
    };
    const toClient = (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      setOpenPath("");
      setView("client");
    };
    const root = { label: "QC Brain", href: "/qc-brain", onClick: back };
    if (view === "client" && detail) return [root, { label: detail.label }];
    // Three deep, because a document now sits under the client it belongs to rather than under the
    // repository — and getting back to the client rather than all the way home is the common move.
    if (view === "doc" && detail) {
      return [root, { label: detail.label, href: "/qc-brain", onClick: toClient }, { label: doc?.title ?? "Document" }];
    }
    if (view === "area" && area) return [root, { label: area.label }];
    if (view === "skills") return [root, { label: "Skills" }];
    if (view === "solo") return [root, { label: doc?.title ?? "Document" }];
    return [{ label: "QC Brain" }];
  }, [view, detail, area, doc?.title, home]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={trail} />
          <div className="top-actions">
            {/*
              In the bar rather than on the page. The index is meant to read as a wall of clients, and
              a full-width search box above it made the first thing on the screen a thing to type in
              rather than the thing people came for. It still has to exist somewhere — four hundred
              documents are not navigable by clicking — so it lives where every other tool's search
              lives, and stays reachable from every screen instead of only the first one.
            */}
            <input
              className="brain-search-input"
              type="search"
              placeholder="Search the brain"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the QC Brain"
            />
            <a className="brain-repo-link" href={repoUrl} target="_blank" rel="noreferrer">
              Open in GitHub
            </a>
            <GlobalAppearanceControl />
          </div>
        </header>

        <main className="brain-page">
          {error && <p className="brain-error">{error}</p>}

          {/*
            When the index failed and nothing arrived, the error is the whole screen. Rendering the
            body underneath it says "no clients found in the repository", which is a different and
            wrong claim — the repository was never reached.
          */}
          {error && !clients.length ? null : searchOpen ? (
            <Results
              hits={hits}
              searching={searching}
              onOpen={(path) => {
                setQuery("");
                setView("solo");
                setOpenPath(path);
              }}
            />
          ) : view === "index" ? (
            <Index loading={loading} clients={clients} areas={areas} onClient={openClient} onArea={openArea} onSkills={openSkills} />
          ) : view === "client" ? (
            <ClientHome
              detail={detail}
              onOpen={(path) => {
                setOpenPath(path);
                setView("doc");
              }}
            />
          ) : view === "doc" ? (
            <ClientDoc
              detail={detail}
              campaigns={campaigns}
              openPath={openPath}
              onOpen={setOpenPath}
              doc={doc}
              docError={docError}
            />
          ) : view === "area" ? (
            <AreaView area={area} openPath={openPath} onOpen={setOpenPath} doc={doc} docError={docError} />
          ) : view === "skills" ? (
            <SkillList skills={skills} openPath={openPath} onOpen={setOpenPath} doc={doc} docError={docError} />
          ) : (
            <Reader doc={doc} error={docError} campaigns={[]} />
          )}
        </main>
      </section>
    </div>
  );
}

/* ── The index ───────────────────────────────────────────────────────────────────────────────── */

/**
 * Every client, as a logo and a name and nothing else.
 *
 * It carried coverage bars, file counts and a chip per document, and that was a worse page: eighteen
 * cards each making five claims is a lot to look at when the only thing anyone does here is pick a
 * client. The completeness figures were not wrong, they were early — they belong on the client's own
 * page, where "4 of 6 core documents" sits next to the six documents and means something.
 *
 * Alphabetical, because that is how you find a name you already have in mind.
 */
function Index({
  loading,
  clients,
  areas,
  onClient,
  onArea,
  onSkills,
}: {
  loading: boolean;
  clients: IndexClient[];
  areas: Area[];
  onClient: (slug: string) => void;
  onArea: (prefix: string) => void;
  onSkills: () => void;
}) {
  if (loading) return <p className="brain-quiet">Reading the brain…</p>;
  if (!clients.length) return <p className="brain-quiet">No clients found in the repository.</p>;

  return (
    <>
      <div className="brain-grid">
        {clients.map((client) => (
          <button key={client.client} className="brain-card" onClick={() => onClient(client.client)}>
            <ClientMark label={client.label} logo={client.logo} slug={client.client} />
            <span className="brain-card-name">{client.label}</span>
          </button>
        ))}
      </div>

      {/* Four destinations, with no heading over them. The heading said only that these were not
          clients, which the wall of clients above had already said — so the gap does that job
          instead, and has to be wide enough to read as a break rather than as a wider row. */}
      <div className="brain-areas">
        {areas.map((entry) => (
          <button
            key={entry.key}
            className="brain-area"
            onClick={() => (entry.key === "commands" ? onSkills() : onArea(entry.prefix))}
          >
            <span className="brain-area-name">{entry.label}</span>
            <span className="brain-area-count">{entry.files} files</span>
          </button>
        ))}
      </div>

      <AskTheBrain />
    </>
  );
}

/**
 * A client's logo, or their initials on a colour of their own.
 *
 * No client in the repo has a logo file today, so in practice this is the monogram — but the way to
 * change that is to commit `logo.png` into the client's folder, which is a thing this team does forty
 * times a day, rather than an upload screen and a second place for client data to live.
 *
 * The image is swapped for the monogram if it fails to load, because a broken-image icon in a grid of
 * eighteen tiles looks like the page is broken rather than like one file is missing.
 */
function ClientMark({ label, logo, slug, size }: { label: string; logo: string; slug: string; size?: "lg" }) {
  const [broken, setBroken] = useState(false);
  const className = `brain-mark${size === "lg" ? " is-lg" : ""}`;
  if (logo && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={logo} alt="" onError={() => setBroken(true)} />;
  }
  return (
    <span className={className} style={{ ["--mark-hue" as string]: String(hue(slug || label)) }} aria-hidden="true">
      {initials(label)}
    </span>
  );
}

/* ── One client ──────────────────────────────────────────────────────────────────────────────── */

/**
 * A client's home page: who they are, what we hold on them, and how their campaigns are doing.
 *
 * This is what the index used to try to say in a card. Given a whole page it can say it properly —
 * every core document as something you can click, with when it last changed, and a plain sentence
 * where a document has never been written. The campaign figures sit here rather than only inside a
 * document that happens to mention a code, because "how is this client actually doing" is a question
 * about the client and not about one file.
 */
function ClientHome({ detail, onOpen }: { detail: ClientDetail | null; onOpen: (path: string) => void }) {
  if (!detail) return <p className="brain-quiet">Opening…</p>;

  const missing = detail.docs.filter((entry) => !entry.present && entry.key !== "dnc");
  const extras = detail.groups.reduce((sum, group) => sum + group.files.length, 0);
  const percent = Math.round(detail.coverage.fraction * 100);

  return (
    <div className="brain-home">
      {/* Who these people are, before anything about what we hold on them. Everyone who opens a
          client page they did not write needs this sentence first, and until now it was three
          clicks and a scroll inside the brief. */}
      <header className="brain-hero">
        <div className="brain-hero-who">
          <ClientMark label={detail.label} logo={detail.logo} slug={detail.client} size="lg" />
          <div className="brain-hero-words">
            <h1>{detail.label}</h1>
            {detail.summary ? (
              <p className="brain-hero-summary">{detail.summary}</p>
            ) : (
              <p className="brain-hero-summary is-empty">
                {detail.briefPath
                  ? "Their brief does not open with a description of the company."
                  : `Nobody has written a brief for ${detail.label} yet.`}
              </p>
            )}
            {detail.facts.length > 0 && (
              <dl className="brain-hero-facts">
                {detail.facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </div>

        {/* The state of the account, kept apart from the description of it. Two different questions
            — "who are they" and "are we ready to work on them" — and mixing them was most of what
            made this page hard to read. */}
        <aside className="brain-hero-state">
          <p className="brain-hero-stat">
            <b>
              {detail.coverage.have}/{detail.coverage.total}
            </b>
            core documents written
          </p>
          <span className="brain-meter" aria-hidden="true">
            <span
              className={`brain-meter-fill${percent === 100 ? " is-full" : percent < 50 ? " is-thin" : ""}`}
              style={{ width: `${percent}%` }}
            />
          </span>
          <p className="brain-hero-stat is-quiet">
            <b>{detail.files}</b>
            files in the brain
          </p>
          {/* The other half of this client. A folder with no workspace behind it is a prospect or a
              dormant account, and that is worth knowing before acting on anything written here. */}
          {detail.workspace ? (
            <a className="brain-home-link" href={`/admin?client=${encodeURIComponent(detail.workspace.slug)}`}>
              <i className={detail.workspace.connected ? "" : "is-off"} />
              {detail.workspace.connected
                ? `Live in Reply Radar as ${detail.workspace.name}`
                : `In Reply Radar as ${detail.workspace.name}, not connected to HeyReach`}
            </a>
          ) : (
            <span className="brain-home-link">
              <i className="is-off" />
              Not set up in Reply Radar
            </span>
          )}
        </aside>
      </header>

      {/* Named in a sentence, not left as an absence to be inferred from a grid. Somebody who came
          here to write the missing one should not have to audit seven cards to find out which. */}
      {missing.length > 0 && (
        <p className="brain-home-missing">
          Nobody has written {list(missing.map((entry) => entry.label.toLowerCase()))} for {detail.label}.
        </p>
      )}

      <h2 className="brain-heading">Start here</h2>
      <p className="brain-sub">The seven documents every client is supposed to have.</p>
      {/* Name and state, and nothing else. The one-line description of what an ICP is belongs to
          somebody's first week, and it was on the tile for ever after — seven of them turned a menu
          into a page of reading when the only thing anybody does here is pick one. */}
      <div className="brain-docgrid">
        {detail.docs.map((entry) => {
          const age = stale(entry.updated);
          return (
            <button
              key={entry.key}
              className={`brain-doccard${entry.present ? "" : " is-missing"}`}
              onClick={() => entry.present && onOpen(entry.path)}
              disabled={!entry.present}
              title={entry.blurb}
            >
              <span className="brain-doccard-icon" aria-hidden="true">
                <DocIcon slot={entry.key} />
              </span>
              <span className="brain-doccard-label">{entry.label}</span>
              <span className={`brain-doccard-age${age.stale ? " is-stale" : ""}`}>
                {entry.present ? (entry.updated ? ago(entry.updated) : "In the repo") : "Not written"}
              </span>
            </button>
          );
        })}
      </div>

      {/* The routines written for this client specifically. The least findable thing in the repo and
          close to the most useful: you learn `/willow-weekly` exists because somebody mentions it. */}
      {detail.skills.length > 0 && (
        <>
          <h2 className="brain-heading">Their routines</h2>
          <p className="brain-sub">Ask for any of these in the MCP chat, or run them from Claude Code.</p>
          <div className="brain-skillrow">
            {detail.skills.map((skill) => (
              <button key={skill.path} className="brain-skillchip" onClick={() => onOpen(skill.path)}>
                <span className="brain-skillchip-cmd">{skill.command}</span>
                {skill.blurb && <span className="brain-skillchip-blurb">{skill.blurb}</span>}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Folded away. Forty call notes listed in full turned a landing page into a file tree, which
          is the thing this whole surface exists to not be — so the folders are shown with their
          counts and open one at a time. */}
      {extras > 0 && <Shelf groups={detail.groups} total={extras} onOpen={onOpen} />}

      <AskTheBrain client={detail.label} />
    </div>
  );
}

/**
 * One glyph per slot, so seven tiles are told apart by shape before they are read.
 *
 * Line drawings rather than filled shapes, at one weight, because these sit at the size where a
 * detailed icon becomes a smudge and the only job they have is to be different from each other.
 */
function DocIcon({ slot }: { slot: string }) {
  const paths: Record<string, string> = {
    brief: "M6 3h8l4 4v14H6zM14 3v4h4",
    icp: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16m0 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0 3.4a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2",
    personas: "M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11m-6 9v-1.2C3 15.6 5.7 14 9 14s6 1.6 6 4.8V20M17 5.2a3.2 3.2 0 0 1 0 6.2m3.9 8.6v-1.1c0-2.3-1.3-3.8-3.4-4.5",
    voice: "M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3M6 11.5a6 6 0 0 0 12 0M12 17.5V21",
    engagement: "M4 19V9m5 10V5m5 14v-7m5 7V8",
    crm: "M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3m0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    dnc: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m-6.4 2.6 12.8 12.8",
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[slot] ?? paths.brief} />
    </svg>
  );
}

/**
 * Where to go when reading is not enough.
 *
 * This surface is deliberately read-mostly: it opens a document and, with the editor, proposes a
 * change to one you already found. Everything else people want — "which clients have no ICP", "does
 * what we wrote match who we are actually contacting", writing a file nobody has opened yet — is a
 * question rather than a click, and the chat is the thing that answers questions. Saying so at the
 * bottom of a client's page is the moment it is wanted, which a line in a settings screen is not.
 */
function AskTheBrain({ client }: { client?: string }) {
  return (
    <aside className="brain-ask">
      <div>
        <h3>Ask the brain instead of browsing it</h3>
        <p>
          The MCP chat reads every file here and can write to it — searching across clients, checking
          what we wrote against what we are actually running, and proposing an edit as a pull request.
        </p>
      </div>
      <a className="brain-ask-go" href="/mcp">
        Open MCP chat
      </a>
      <span className="brain-ask-hint">
        {client ? `Try “What does the brain say about ${client}?”` : "Type / in the chat to run one of the brain’s skills"}
      </span>
    </aside>
  );
}

/** Everything that is not a core document, one folder open at a time. */
function Shelf({ groups, total, onOpen }: { groups: Group[]; total: number; onOpen: (path: string) => void }) {
  const [open, setOpen] = useState("");
  return (
    <>
      <h2 className="brain-heading">Everything else</h2>
      <p className="brain-sub">
        {total} more {total === 1 ? "file" : "files"}, by folder.
      </p>
      <div className="brain-shelf">
        {groups.map((group) => {
          const name = group.folder || "Loose files";
          const isOpen = open === name;
          return (
            <div key={name} className={`brain-shelf-group${isOpen ? " is-open" : ""}`}>
              <button className="brain-shelf-head" onClick={() => setOpen(isOpen ? "" : name)} aria-expanded={isOpen}>
                <span className="brain-shelf-name">{name}</span>
                <span className="brain-shelf-count">{group.files.length}</span>
              </button>
              {isOpen && (
                <ul className="brain-more-list">
                  {group.files.map((file) => (
                    <li key={file.path}>
                      <button className="brain-more-file" onClick={() => onOpen(file.path)}>
                        <span className="brain-more-title">{file.title}</span>
                        <span className="brain-more-kind">{kindOf(file.path)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** "icp, personas and voice" — an English list, because this goes inside a sentence. */
const list = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/**
 * Every campaign QC is running for this client, against the same axis.
 *
 * The join, and the reason this tab is in Reply Radar. Shown whole on the client's page and filtered
 * to the codes a document mentions when reading one, so the same figures answer both "how are they
 * doing" and "did the thing this note describes work".
 */
function CampaignStrip({ campaigns, heading }: { campaigns: Campaign[]; heading: string }) {
  if (!campaigns.length) return null;
  return (
    <div className="brain-campaigns">
      <h3 className="brain-campaigns-head">{heading}</h3>
      <ul className="brain-campaign-list">
        {campaigns.map((campaign) => (
          <li key={campaign.id} className="brain-campaign">
            <span className="brain-campaign-name">{campaign.name}</span>
            <span className="brain-campaign-bar" aria-hidden="true">
              <span className="brain-campaign-fill" style={{ width: `${Math.min(100, Math.round(campaign.replyRate))}%` }} />
            </span>
            <span className="brain-campaign-figures">
              {campaign.replyRate.toFixed(1)}% replied · {campaign.replies} of {campaign.conversationsStarted} conversations
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Reading one of a client's documents, with the rest of them still one click away. */
function ClientDoc({
  detail,
  campaigns,
  openPath,
  onOpen,
  doc,
  docError,
}: {
  detail: ClientDetail | null;
  campaigns: Campaign[];
  openPath: string;
  onOpen: (path: string) => void;
  doc: FileDoc | null;
  docError: string;
}) {
  const [more, setMore] = useState(false);
  if (!detail) return <p className="brain-quiet">Opening…</p>;

  const extras = detail.groups.reduce((sum, group) => sum + group.files.length, 0);

  return (
    <div className="brain-client">
      <nav className="brain-tabs" aria-label="Documents">
        {detail.docs.map((entry) => {
          const age = stale(entry.updated);
          return (
            <button
              key={entry.key}
              className={`brain-tab${openPath === entry.path && entry.present ? " is-open" : ""}${entry.present ? "" : " is-missing"}`}
              onClick={() => entry.present && onOpen(entry.path)}
              disabled={!entry.present}
              title={entry.present ? entry.blurb : `Nobody has written ${entry.label.toLowerCase()} for ${detail.label} yet`}
            >
              {entry.label}
              {/* Two different absences, said differently: a dash is "never written", a dot is "not
                  touched in months". They call for different work, so they cannot look the same. */}
              {!entry.present && <span className="brain-tab-flag" aria-label="Not written">—</span>}
              {entry.present && age.stale && (
                <span className="brain-tab-flag is-stale" title={`Last changed ${ago(entry.updated)}`} aria-label="Not changed in months">
                  ·
                </span>
              )}
            </button>
          );
        })}
        {extras > 0 && (
          <button className={`brain-tab brain-tab-more${more ? " is-open" : ""}`} onClick={() => setMore((open) => !open)}>
            More ({extras})
          </button>
        )}
      </nav>

      {more && (
        <div className="brain-more">
          {detail.groups.map((group) => (
            <div key={group.folder} className="brain-more-group">
              {group.folder && <h3 className="brain-more-folder">{group.folder}</h3>}
              <ul className="brain-more-list">
                {group.files.map((file) => (
                  <li key={file.path}>
                    <button
                      className={`brain-more-file${openPath === file.path ? " is-open" : ""}`}
                      onClick={() => {
                        onOpen(file.path);
                        setMore(false);
                      }}
                    >
                      <span className="brain-more-title">{file.title}</span>
                      <span className="brain-more-kind">{kindOf(file.path)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <Reader doc={doc} error={docError} campaigns={campaigns} />
    </div>
  );
}

/* ── Reading and editing a document ──────────────────────────────────────────────────────────── */

/**
 * A document, its live campaign figures, and the way to change it.
 *
 * The campaign strip is the join, and it shows only codes that matched a campaign that exists. An
 * invented code from the extractor silently stays plain text rather than becoming a dead row, which
 * is what lets the extractor be generous enough to catch every real one.
 */
function Reader({ doc, error, campaigns }: { doc: FileDoc | null; error: string; campaigns: Campaign[] }) {
  /**
   * An edit belongs to one file, so it is stored with the path it belongs to.
   *
   * Opening a different document has to abandon the draft — carrying one file's text onto another and
   * proposing it would be a genuinely destructive bug. Holding the path alongside the draft makes that
   * a comparison at render time instead of five state resets fired the moment the document changes.
   */
  const [session, setSession] = useState<{ path: string; draft: string; summary: string; error: string } | null>(null);
  const [pull, setPull] = useState<{ path: string; url: string; number: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const path = doc?.path ?? "";
  const editing = session && session.path === path ? session : null;
  const proposed = pull && pull.path === path ? pull : null;

  const wanted = new Set(doc?.codes ?? []);
  const mentioned = wanted.size ? campaigns.filter((campaign) => wanted.has(campaign.code)) : [];

  const propose = async () => {
    if (!doc || !editing) return;
    setSaving(true);
    setSession({ ...editing, error: "" });
    try {
      const response = await fetch("/api/brain/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: doc.path, text: editing.draft, sha: doc.sha, summary: editing.summary.trim() }),
      });
      const body = await response.json().catch(() => ({}));
      if (!body?.ok) throw new Error(body?.error || "The change could not be proposed.");
      setPull({ path: doc.path, url: String(body.url), number: Number(body.number) });
      setSession(null);
    } catch (problem) {
      setSession({ ...editing, error: problem instanceof Error ? problem.message : "The change could not be proposed." });
    } finally {
      setSaving(false);
    }
  };

  if (error) return <p className="brain-error">{error}</p>;
  if (!doc) return <p className="brain-quiet">Loading…</p>;

  if (doc.kind !== "doc") {
    return (
      <div className="brain-doc">
        <p className="brain-quiet">
          {doc.title} is a {doc.kind} file, which is not something to read on a page.{" "}
          <a href={doc.url} target="_blank" rel="noreferrer">
            Open it in GitHub
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="brain-doc">
      <div className="brain-doc-bar">
        <span className="brain-doc-path">{doc.path}</span>
        <span className="brain-doc-actions">
          {doc.updated && <span className="brain-doc-age">Changed {ago(doc.updated)}</span>}
          <a className="brain-doc-link" href={doc.url} target="_blank" rel="noreferrer">
            GitHub
          </a>
          {!editing && (
            <button
              className="brain-doc-edit"
              onClick={() => setSession({ path: doc.path, draft: doc.text, summary: `Update ${doc.title}`, error: "" })}
            >
              Edit
            </button>
          )}
        </span>
      </div>

      {proposed && (
        <p className="brain-proposed">
          Proposed as pull request #{proposed.number}.{" "}
          <a href={proposed.url} target="_blank" rel="noreferrer">
            Review and merge it
          </a>{" "}
          — nothing changes for the team until you do.
        </p>
      )}

      {!editing && <CampaignStrip campaigns={mentioned} heading="Campaigns this mentions, as they are actually doing" />}

      {editing ? (
        <div className="brain-editor">
          <textarea
            className="brain-editor-text"
            value={editing.draft}
            onChange={(event) => setSession({ ...editing, draft: event.target.value })}
            spellCheck={false}
            aria-label={`Editing ${doc.path}`}
          />
          <div className="brain-editor-foot">
            <input
              className="brain-editor-summary"
              value={editing.summary}
              onChange={(event) => setSession({ ...editing, summary: event.target.value })}
              placeholder="What changed? This becomes the title of the pull request."
              aria-label="Summary of the change"
            />
            <button className="brain-editor-cancel" onClick={() => setSession(null)} disabled={saving}>
              Cancel
            </button>
            <button
              className="brain-editor-save"
              onClick={() => void propose()}
              disabled={saving || !editing.summary.trim() || editing.draft === doc.text}
            >
              {saving ? "Proposing…" : "Propose change"}
            </button>
          </div>
          {editing.error && <p className="brain-error">{editing.error}</p>}
          <p className="brain-editor-note">
            This opens a pull request rather than saving. Everyone&apos;s Claude Code reads this repository, so a
            change here becomes what the whole team is told — it gets reviewed first.
          </p>
        </div>
      ) : (
        <Markdown>{doc.text}</Markdown>
      )}
    </div>
  );
}

/* ── Areas, skills and search results ────────────────────────────────────────────────────────── */

function FileList({
  groups,
  openPath,
  onOpen,
  label,
}: {
  groups: Group[];
  openPath: string;
  onOpen: (path: string) => void;
  label: string;
}) {
  return (
    <nav className="brain-filelist" aria-label={label}>
      {groups.map((group) => (
        <div key={group.folder}>
          {group.folder && <h3 className="brain-more-folder">{group.folder}</h3>}
          <ul className="brain-more-list">
            {group.files.map((file) => (
              <li key={file.path}>
                <button className={`brain-more-file${openPath === file.path ? " is-open" : ""}`} onClick={() => onOpen(file.path)}>
                  <span className="brain-more-title">{file.title}</span>
                  <span className="brain-more-kind">{kindOf(file.path)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function AreaView({
  area,
  openPath,
  onOpen,
  doc,
  docError,
}: {
  area: { label: string; blurb: string; groups: Group[] } | null;
  openPath: string;
  onOpen: (path: string) => void;
  doc: FileDoc | null;
  docError: string;
}) {
  if (!area) return <p className="brain-quiet">Opening…</p>;
  return (
    <div className="brain-area-view">
      <p className="brain-sub">{area.blurb}</p>
      <div className="brain-split">
        <FileList groups={area.groups} openPath={openPath} onOpen={onOpen} label={area.label} />
        <div className="brain-pane">
          {openPath ? <Reader doc={doc} error={docError} campaigns={[]} /> : <p className="brain-quiet">Pick something to read.</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * The slash commands, which are the least discoverable thing in the repository.
 *
 * Today you find out one of these exists because somebody mentions it in Slack. Each is a routine
 * another person already worked out, so listing them with a sentence each is most of the value.
 */
function SkillList({
  skills,
  openPath,
  onOpen,
  doc,
  docError,
}: {
  skills: Skill[];
  openPath: string;
  onOpen: (path: string) => void;
  doc: FileDoc | null;
  docError: string;
}) {
  if (!skills.length) return <p className="brain-quiet">Reading the commands…</p>;
  return (
    <div className="brain-area-view">
      <p className="brain-sub">
        Type any of these into Claude Code with the QC Brain connected. Each one is a routine somebody has
        already worked out.
      </p>
      <div className="brain-split">
        <nav className="brain-filelist" aria-label="Skills">
          <ul className="brain-more-list">
            {skills.map((skill) => (
              <li key={skill.path}>
                <button className={`brain-skill${openPath === skill.path ? " is-open" : ""}`} onClick={() => onOpen(skill.path)}>
                  <span className="brain-skill-head">
                    <span className="brain-skill-command">{skill.command}</span>
                    {skill.clientLabel && <span className="brain-skill-client">{skill.clientLabel}</span>}
                  </span>
                  <span className="brain-skill-blurb">{skill.blurb || "No description written."}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="brain-pane">
          {openPath ? (
            <Reader doc={doc} error={docError} campaigns={[]} />
          ) : (
            <p className="brain-quiet">Pick a command to read what it does.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Results({ hits, searching, onOpen }: { hits: Hit[]; searching: boolean; onOpen: (path: string) => void }) {
  if (!hits.length) {
    return (
      <p className="brain-quiet">
        {searching ? "Searching the whole repository…" : "Nothing matched. Every word has to appear somewhere — try fewer."}
      </p>
    );
  }
  return (
    <ul className="brain-results">
      {hits.map((hit) => (
        <li key={hit.path}>
          <button className="brain-result" onClick={() => onOpen(hit.path)}>
            <span className="brain-result-head">
              <span className="brain-result-title">{hit.title}</span>
              {hit.clientLabel && <span className="brain-result-client">{hit.clientLabel}</span>}
            </span>
            {hit.snippet && <span className="brain-result-snippet">{hit.snippet}</span>}
            <span className="brain-result-path">{hit.path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
