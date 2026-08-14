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
 * ── State ───────────────────────────────────────────────────────────────────────────────────────
 * One component with a `view` field rather than nested routes. The whole surface is four screens over
 * one cached tree and every transition is instant from data already in hand; splitting it across
 * routes would add a navigation and a re-fetch to every click for no gain.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import Markdown from "../components/Markdown";
import { agoLabel, fileKind, staleness } from "../../shared/brain-structure.mjs";

type Coverage = { have: number; total: number; fraction: number };
type IndexClient = { client: string; label: string; docs: { key: string; label: string; path: string; present: boolean }[]; files: number; coverage: Coverage };
type Area = { key: string; label: string; prefix: string; blurb: string; files: number };
type Doc = { key: string; label: string; blurb: string; path: string; present: boolean; updated: string };
type Group = { folder: string; files: { path: string; name: string; title: string }[] };
type ClientDetail = { client: string; label: string; docs: Doc[]; groups: Group[]; coverage: Coverage };
type Campaign = { code: string; id: string; name: string; conversationsStarted: number; replies: number; replyRate: number };
type FileDoc = { path: string; kind: string; title: string; text: string; sha: string; url: string; codes: string[]; updated: string };
type Hit = { path: string; title: string; snippet: string; client: string; clientLabel: string; url: string };
type Skill = { name: string; path: string; command: string; blurb: string; client: string; clientLabel: string; url: string };

const ago = agoLabel as (iso: string, now?: number) => string;
const stale = staleness as (iso: string, now?: number) => { days: number | null; stale: boolean };
const kindOf = fileKind as (path: string) => string;

const json = async (url: string) => {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!body?.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body;
};

export default function QcBrainPage() {
  const [view, setView] = useState<"index" | "client" | "area" | "skills" | "solo">("index");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [clients, setClients] = useState<IndexClient[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [total, setTotal] = useState(0);
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
        setTotal(body.total ?? 0);
        if (body.repoUrl) setRepoUrl(body.repoUrl);
      })
      .catch((problem: Error) => setError(problem.message))
      .finally(() => setLoading(false));
  }, []);

  const openClient = useCallback((slug: string) => {
    if (!slug) return;
    setView("client");
    setDetail(null);
    setCampaigns([]);
    setOpenPath("");
    setError("");
    json(`/api/brain/clients?client=${encodeURIComponent(slug)}`)
      .then((body) => {
        setDetail(body.client);
        // The first document that exists, so the page opens on something rather than on a chooser.
        const first = (body.client?.docs ?? []).find((entry: Doc) => entry.present) as Doc | undefined;
        if (first) setOpenPath(first.path);
      })
      .catch((problem: Error) => setError(problem.message));
    // Campaign figures come from HeyReach and take seconds. Fetched alongside rather than before, so
    // the documents are readable while the numbers are still on their way.
    json(`/api/brain/campaigns?client=${encodeURIComponent(slug)}`)
      .then((body) => setCampaigns(body.campaigns ?? []))
      .catch(() => setCampaigns([]));
  }, []);

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

  const home = useCallback(() => {
    setView("index");
    setDetail(null);
    setArea(null);
    setOpenPath("");
    setError("");
  }, []);

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
    if (view === "client" && detail) return [{ label: "QC Brain", href: "/qc-brain", onClick: back }, { label: detail.label }];
    if (view === "area" && area) return [{ label: "QC Brain", href: "/qc-brain", onClick: back }, { label: area.label }];
    if (view === "skills") return [{ label: "QC Brain", href: "/qc-brain", onClick: back }, { label: "Skills" }];
    if (view === "solo") return [{ label: "QC Brain", href: "/qc-brain", onClick: back }, { label: doc?.title ?? "Document" }];
    return [{ label: "QC Brain" }];
  }, [view, detail, area, doc?.title, home]);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={trail} />
          <div className="top-actions">
            <a className="brain-repo-link" href={repoUrl} target="_blank" rel="noreferrer">
              Open in GitHub
            </a>
            <GlobalAppearanceControl />
          </div>
        </header>

        <main className="brain-page">
          <div className="brain-search">
            <input
              className="brain-search-input"
              type="search"
              placeholder="Search everything — a client, a campaign code, a phrase someone wrote"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the QC Brain"
            />
            {searchOpen && (
              <span className="brain-search-state">
                {searching ? "Searching…" : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
              </span>
            )}
          </div>

          {error && <p className="brain-error">{error}</p>}

          {searchOpen ? (
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
            <Index
              loading={loading}
              clients={clients}
              areas={areas}
              total={total}
              onClient={openClient}
              onArea={openArea}
              onSkills={openSkills}
            />
          ) : view === "client" ? (
            <ClientView
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
 * Every client as a card, ordered by how much context is missing.
 *
 * Alphabetical would be the obvious ordering and it would waste the page. This list exists to show
 * where the gaps are, so the gaps go at the top — somebody opening the tab to do a tidy sees the work
 * without scrolling, and somebody looking for a particular client uses the search box anyway.
 */
function Index({
  loading,
  clients,
  areas,
  total,
  onClient,
  onArea,
  onSkills,
}: {
  loading: boolean;
  clients: IndexClient[];
  areas: Area[];
  total: number;
  onClient: (slug: string) => void;
  onArea: (prefix: string) => void;
  onSkills: () => void;
}) {
  const ordered = useMemo(
    () => [...clients].sort((a, b) => a.coverage.fraction - b.coverage.fraction || a.label.localeCompare(b.label)),
    [clients],
  );

  if (loading) return <p className="brain-quiet">Reading the brain…</p>;
  if (!clients.length) return <p className="brain-quiet">No clients found in the repository.</p>;

  const complete = clients.filter((client) => client.coverage.fraction === 1).length;
  const average = Math.round((clients.reduce((sum, client) => sum + client.coverage.fraction, 0) / clients.length) * 100);

  return (
    <>
      <div className="brain-summary">
        <Stat label="Clients" value={String(clients.length)} note={`${complete} fully written up`} />
        <Stat label="Documents" value={String(total)} note="across the whole repository" />
        <Stat label="Core context" value={`${average}%`} note="average completeness" />
      </div>

      <h2 className="brain-heading">Clients</h2>
      <p className="brain-sub">Least complete first, because the gaps are the reason to look.</p>
      <div className="brain-grid">
        {ordered.map((client) => (
          <button key={client.client} className="brain-card" onClick={() => onClient(client.client)}>
            <span className="brain-card-head">
              <span className="brain-card-name">{client.label}</span>
              <span className="brain-card-count">{client.files} files</span>
            </span>
            <span className="brain-meter" aria-hidden="true">
              <span
                className={`brain-meter-fill${client.coverage.fraction === 1 ? " is-full" : client.coverage.fraction < 0.5 ? " is-thin" : ""}`}
                style={{ width: `${Math.round(client.coverage.fraction * 100)}%` }}
              />
            </span>
            <span className="brain-card-cover">
              {client.coverage.have} of {client.coverage.total} core documents
            </span>
            <span className="brain-chips">
              {client.docs
                .filter((entry) => entry.key !== "dnc")
                .map((entry) => (
                  <span key={entry.key} className={`brain-chip${entry.present ? " is-present" : ""}`}>
                    {entry.label}
                  </span>
                ))}
            </span>
          </button>
        ))}
      </div>

      <h2 className="brain-heading">Everything else</h2>
      <div className="brain-areas">
        {areas.map((entry) => (
          <button
            key={entry.key}
            className="brain-area"
            onClick={() => (entry.key === "commands" ? onSkills() : onArea(entry.prefix))}
          >
            <span className="brain-area-name">{entry.label}</span>
            <span className="brain-area-blurb">{entry.blurb}</span>
            <span className="brain-area-count">{entry.files} files</span>
          </button>
        ))}
      </div>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="brain-stat">
      <span className="brain-stat-value">{value}</span>
      <span className="brain-stat-label">{label}</span>
      <span className="brain-stat-note">{note}</span>
    </div>
  );
}

/* ── One client ──────────────────────────────────────────────────────────────────────────────── */

function ClientView({
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
  const written = detail.docs.some((entry) => entry.present);

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

      {written ? (
        <Reader doc={doc} error={docError} campaigns={campaigns} />
      ) : (
        <p className="brain-quiet">Nothing has been written for {detail.label} yet.</p>
      )}
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

      {mentioned.length > 0 && !editing && (
        <div className="brain-campaigns">
          <h3 className="brain-campaigns-head">Campaigns this mentions, as they are actually doing</h3>
          <ul className="brain-campaign-list">
            {mentioned.map((campaign) => (
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
      )}

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
