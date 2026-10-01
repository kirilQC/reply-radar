// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The Help center, laid out like product docs.
 *
 * Left: search, a kind filter, and every article grouped under the page it is about, each with its own
 * topic icon. Middle: the article (screenshot first, then numbered steps), or a home view when nothing
 * is open. Right: a shortcut into the page itself, related articles and the way to ask QC Bot.
 *
 * Read-first: "Edit help" reveals the add / edit / reorder / delete controls. The same articles are what
 * the Slack QC Bot and the MCP assistant read through their help_center tool, and the bot links to them
 * as /help#<id>, which opens that article here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import Markdown from "../components/Markdown";
import { HELP_KINDS, HELP_PAGES, type HelpArticle, type HelpImage, type HelpKind, loomEmbedUrl, pageLabel } from "../lib/help-shared";
import { ARROW_PATH, EXPAND_PATH, Glyph, HOME_PATH, kindPath, pagePath, SEARCH_PATH, topicPath } from "./HelpIcons";
import "./help.css";

type Draft = { id?: string; kind: HelpKind; title: string; body: string; loomUrl: string; page: string; keywords: string };
type KindFilter = HelpKind | "all";

const emptyDraft = (kind: HelpKind, page = ""): Draft => ({ kind, title: "", body: "", loomUrl: "", page, keywords: "" });
const KIND_SHORT: Record<HelpKind, string> = { walkthrough: "Guide", faq: "FAQ", troubleshooting: "Fix", support: "Support" };
const KIND_ORDER: HelpKind[] = ["walkthrough", "faq", "troubleshooting", "support"];
const FEEDBACK_KEY = "reply-radar-help-feedback";

const matches = (article: HelpArticle, query: string) => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${article.title} ${article.body} ${article.keywords.join(" ")} ${pageLabel(article.page)}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

const stepCount = (body: string) => body.split("\n").filter((line) => /^\d+\.\s/.test(line.trim())).length;
const readMinutes = (body: string) => Math.max(1, Math.round(body.split(/\s+/).length / 200));

function readFeedback(): Record<string, "up" | "down"> {
  try {
    return JSON.parse(window.localStorage.getItem(FEEDBACK_KEY) || "{}");
  } catch {
    return {};
  }
}

export default function HelpPage() {
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [lightbox, setLightbox] = useState<HelpImage | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
  const [progress, setProgress] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFeedback(readFeedback());
    void fetch("/api/help", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (Array.isArray(payload?.articles)) setArticles(payload.articles);
        if (payload?.ok === false) setError(String(payload.error ?? "Help could not be loaded."));
      })
      .catch(() => setError("Help could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  /** Every page that has articles, in sidebar order, then the general ones. */
  const groups = useMemo(() => {
    const sortInGroup = (list: HelpArticle[]) =>
      [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.order - b.order);
    const out = HELP_PAGES.map((page) => ({ path: page.path, label: page.label, items: sortInGroup(articles.filter((a) => a.page === page.path)) }));
    out.push({ path: "", label: "General", items: sortInGroup(articles.filter((a) => !a.page || !HELP_PAGES.some((p) => p.path === a.page))) });
    return out.filter((group) => group.items.length);
  }, [articles]);

  const ordered = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const current = currentId ? articles.find((a) => a.id === currentId) ?? null : null;
  const searching = query.trim().length > 0;

  const visibleGroups = useMemo(
    () => groups
      .map((group) => ({ ...group, items: group.items.filter((a) => (kind === "all" || a.kind === kind) && matches(a, query)) }))
      .filter((group) => group.items.length),
    [groups, kind, query],
  );
  const resultCount = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: articles.length };
    for (const a of articles) map[a.kind] = (map[a.kind] ?? 0) + 1;
    return map;
  }, [articles]);

  const open = useCallback((id: string | null, options: { scroll?: boolean } = {}) => {
    setDraft(null);
    setCurrentId(id);
    setNavOpen(false);
    const article = id ? articles.find((a) => a.id === id) : null;
    if (article) setOpenGroups((prev) => new Set(prev).add(article.page && HELP_PAGES.some((p) => p.path === article.page) ? article.page : ""));
    window.history.replaceState(null, "", id ? `#${id}` : window.location.pathname);
    if (options.scroll !== false) centerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [articles]);

  // /help#<id> (what the bot hands out) opens that article.
  useEffect(() => {
    if (loading || !articles.length) return;
    const fromHash = () => {
      const id = window.location.hash.replace("#", "");
      if (id && articles.some((a) => a.id === id)) open(id, { scroll: false });
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [loading, articles, open]);

  // "/" jumps to search; ← and → step through articles.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.key === "Escape") { setLightbox(null); setNavOpen(false); }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "/") { event.preventDefault(); searchRef.current?.focus(); }
      if (!current) return;
      const at = ordered.findIndex((a) => a.id === current.id);
      if (event.key === "ArrowRight" && ordered[at + 1]) open(ordered[at + 1].id);
      if (event.key === "ArrowLeft" && ordered[at - 1]) open(ordered[at - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, ordered, open]);

  // Reading progress for the open article.
  useEffect(() => {
    if (!current) { setProgress(0); return; }
    const onScroll = () => {
      const el = articleRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = rect.height - window.innerHeight * 0.6;
      setProgress(total <= 0 ? 1 : Math.min(1, Math.max(0, (window.innerHeight * 0.2 - rect.top) / total)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [current]);

  const post = async (payload: Record<string, unknown>) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/help", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(String(data.error ?? "The change could not be saved."));
      setArticles(data.articles);
      return data.articles as HelpArticle[];
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft || !draft.title.trim()) return;
    const saved = await post({ action: "save", article: { ...draft, keywords: draft.keywords.split(",").map((word) => word.trim()).filter(Boolean) } });
    if (!saved) return;
    const id = draft.id ?? saved.find((a) => a.title === draft.title.trim())?.id ?? null;
    setDraft(null);
    if (id) open(id);
  };

  const startEdit = (article: HelpArticle) =>
    setDraft({ id: article.id, kind: article.kind, title: article.title, body: article.body, loomUrl: article.loomUrl, page: article.page, keywords: article.keywords.join(", ") });

  const rate = (id: string, value: "up" | "down") => {
    const next = { ...feedback, [id]: value };
    setFeedback(next);
    try { window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(next)); } catch { /* private window: the thanks still shows */ }
  };

  const toggleGroup = (path: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });

  const groupOf = (article: HelpArticle) => groups.find((g) => g.items.some((a) => a.id === article.id));

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={current ? [{ label: "Help", href: "/help" }, { label: current.title }] : [{ label: "Help" }]} />
          <div className="top-actions">
            <button type="button" className="hd-browse" onClick={() => setNavOpen((v) => !v)} aria-expanded={navOpen}>
              <Glyph d="M4 6h16 M4 12h16 M4 18h10" size={14} /> Browse
            </button>
            <button type="button" className={`help-edit-toggle ${editing ? "on" : ""}`} onClick={() => { setEditing((value) => !value); setDraft(null); }}>
              {editing ? "Done editing" : "Edit help"}
            </button>
            <GlobalAppearanceControl />
          </div>
        </header>

        <div className="hd">
          {/* ── Navigation ── */}
          <aside className={`hd-nav ${navOpen ? "open" : ""}`} aria-label="Help articles">
            <label className="hd-search">
              <Glyph d={SEARCH_PATH} size={15} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && visibleGroups[0]) open(visibleGroups[0].items[0].id);
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder="Search help"
                aria-label="Search help"
              />
              {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search">✕</button> : <kbd>/</kbd>}
            </label>

            <div className="hd-kinds" role="tablist" aria-label="Filter by type">
              {(["all", ...KIND_ORDER] as KindFilter[]).map((key) => (
                <button key={key} type="button" role="tab" aria-selected={kind === key} className={kind === key ? "on" : ""} onClick={() => setKind(key)} title={key === "all" ? "Everything" : HELP_KINDS.find((k) => k.key === key)?.label}>
                  {key === "all" ? <Glyph d={HOME_PATH} size={13} /> : <Glyph d={kindPath(key)} size={13} />}
                  <span>{key === "all" ? "All" : KIND_SHORT[key]}</span>
                  <small>{counts[key] ?? 0}</small>
                </button>
              ))}
            </div>

            <button type="button" className={`hd-home ${!current && !draft ? "on" : ""}`} onClick={() => open(null)}>
              <span className="hd-ico"><Glyph d={HOME_PATH} size={14} /></span>Help home
            </button>

            {editing && (
              <button type="button" className="hd-add" onClick={() => { setCurrentId(null); setDraft(emptyDraft(kind === "all" ? "walkthrough" : kind, current?.page ?? "")); }}>
                + Add article
              </button>
            )}

            {searching && <p className="hd-count">{resultCount ? `${resultCount} result${resultCount === 1 ? "" : "s"} · Enter opens the first` : "Nothing matches. Try other words, or ask QC Bot."}</p>}

            {loading ? (
              <div className="hd-skel">{Array.from({ length: 8 }).map((_, i) => <span key={i} className="sk sk-line" style={{ width: `${60 + ((i * 17) % 35)}%` }} />)}</div>
            ) : (
              <div className="hd-groups">
                {visibleGroups.map((group, gi) => {
                  const expanded = searching || kind !== "all" || openGroups.has(group.path) || group.items.some((a) => a.id === currentId);
                  return (
                    <div key={group.path || "general"} className={`hd-group ${expanded ? "expanded" : ""}`} style={{ ["--i" as string]: gi }}>
                      <button type="button" className="hd-group-head" onClick={() => toggleGroup(group.path)} aria-expanded={expanded}>
                        <span className="hd-ico"><Glyph d={pagePath(group.path)} size={14} /></span>
                        <span className="hd-group-label">{group.label}</span>
                        <small>{group.items.length}</small>
                        <span className="hd-caret" aria-hidden>›</span>
                      </button>
                      <div className="hd-group-body">
                        <div className="hd-group-inner">
                          {group.items.map((article) => (
                            <button key={article.id} type="button" className={`hd-item kind-${article.kind} ${article.id === currentId ? "on" : ""}`} onClick={() => open(article.id)} aria-current={article.id === currentId}>
                              <Glyph d={topicPath(article)} size={13} className="hd-item-ico" />
                              <span>{article.title}</span>
                              {article.kind !== "walkthrough" && <i className="hd-dot" title={HELP_KINDS.find((k) => k.key === article.kind)?.label} />}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </aside>
          {navOpen && <button type="button" className="hd-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

          {/* ── Centre ── */}
          <main className="hd-center" ref={centerRef}>
            {current && <div className="hd-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden />}
            {error && <p className="help-error" role="alert">{error}</p>}

            {draft ? (
              <div className="hd-editor hd-rise" key="editor">
                <h2>{draft.id ? "Edit article" : "New article"}</h2>
                <div className="help-editor">
                  <div className="help-editor-row">
                    <label>
                      Section
                      <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as HelpKind })}>
                        {HELP_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                      </select>
                    </label>
                    <label>
                      About which page
                      <select value={draft.page} onChange={(event) => setDraft({ ...draft, page: event.target.value })}>
                        <option value="">General</option>
                        {HELP_PAGES.map((page) => <option key={page.path} value={page.path}>{page.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label>
                    Title
                    <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="e.g. How to tag a lead as DQ" autoFocus />
                  </label>
                  <label>
                    Loom video link <em>optional</em>
                    <input value={draft.loomUrl} onChange={(event) => setDraft({ ...draft, loomUrl: event.target.value })} placeholder="https://www.loom.com/share/…" />
                  </label>
                  <label>
                    Steps / answer <em>Markdown: **bold**, - bullets, 1. numbered steps</em>
                    <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={11} placeholder={"1. Open the Inbox\n2. Click a reply\n3. Click + Tag and pick DQ"} />
                  </label>
                  <label>
                    Search keywords <em>comma separated: words people might type that are not in the title</em>
                    <input value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} placeholder="dq, disqualify, label" />
                  </label>
                  <div className="help-editor-actions">
                    <button type="button" className="help-ghost" onClick={() => setDraft(null)}>Cancel</button>
                    <button type="button" className="help-primary" disabled={saving || !draft.title.trim()} onClick={() => void saveDraft()}>
                      {saving ? "Saving…" : draft.id ? "Save changes" : "Add article"}
                    </button>
                  </div>
                </div>
              </div>
            ) : current ? (
              <ArticleView
                key={current.id}
                article={current}
                refEl={articleRef}
                group={groupOf(current)?.label ?? ""}
                prev={ordered[ordered.findIndex((a) => a.id === current.id) - 1]}
                next={ordered[ordered.findIndex((a) => a.id === current.id) + 1]}
                rating={feedback[current.id]}
                onRate={(value) => rate(current.id, value)}
                onOpen={open}
                onGroup={() => { const g = groupOf(current); if (g) setOpenGroups((prev) => new Set(prev).add(g.path)); setNavOpen(true); }}
                onZoom={setLightbox}
                editing={editing}
                saving={saving}
                siblings={articles.filter((a) => a.kind === current.kind)}
                onEdit={() => startEdit(current)}
                onMove={(direction) => void post({ action: "move", id: current.id, direction })}
                onDelete={async () => {
                  if (!window.confirm(`Delete “${current.title}”?`)) return;
                  if (await post({ action: "delete", id: current.id })) open(null);
                }}
              />
            ) : (
              <HomeView loading={loading} articles={articles} groups={groups} onOpen={open} onSearch={() => searchRef.current?.focus()} />
            )}
          </main>

          {/* ── Right rail ── */}
          <aside className="hd-rail" aria-label="Related">
            {current && !draft ? (
              <div className="hd-rail-inner hd-rise" key={`rail-${current.id}`}>
                {current.page && (
                  <a className="hd-cta" href={current.page}>
                    <Glyph d={pagePath(current.page)} size={15} />Open {pageLabel(current.page)}<Glyph d={ARROW_PATH} size={14} className="hd-cta-arrow" />
                  </a>
                )}
                <RailList title={`More on ${groupOf(current)?.label ?? "this"}`} items={(groupOf(current)?.items ?? []).filter((a) => a.id !== current.id).slice(0, 6)} onOpen={open} />
                <RailList
                  title="Related"
                  items={articles.filter((a) => a.id !== current.id && a.page !== current.page && a.keywords.some((k) => current.keywords.includes(k))).slice(0, 4)}
                  onOpen={open}
                />
                <AskBot />
              </div>
            ) : (
              <div className="hd-rail-inner">
                <div className="hd-rail-box">
                  <span className="hd-eyebrow">Shortcuts</span>
                  <p className="hd-keys"><kbd>/</kbd> search <kbd>←</kbd><kbd>→</kbd> previous / next <kbd>Esc</kbd> close</p>
                </div>
                <AskBot />
              </div>
            )}
          </aside>
        </div>

        {lightbox && (
          <div className="hd-lightbox" role="dialog" aria-modal="true" aria-label={lightbox.caption || "Screenshot"} onClick={() => setLightbox(null)}>
            <figure onClick={(event) => event.stopPropagation()}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={lightbox.src} alt={lightbox.caption} />
              {lightbox.caption && <figcaption>{lightbox.caption}</figcaption>}
            </figure>
            <button type="button" className="hd-lightbox-x" onClick={() => setLightbox(null)} aria-label="Close">✕</button>
          </div>
        )}
      </section>
    </div>
  );
}

function ArticleView(props: {
  article: HelpArticle;
  refEl: React.RefObject<HTMLDivElement | null>;
  group: string;
  prev?: HelpArticle;
  next?: HelpArticle;
  rating?: "up" | "down";
  onRate: (value: "up" | "down") => void;
  onOpen: (id: string) => void;
  onGroup: () => void;
  onZoom: (image: HelpImage) => void;
  editing: boolean;
  saving: boolean;
  siblings: HelpArticle[];
  onEdit: () => void;
  onMove: (direction: "up" | "down") => void;
  onDelete: () => void;
}) {
  const { article } = props;
  const embed = loomEmbedUrl(article.loomUrl);
  const [hero, ...rest] = article.images ?? [];
  const steps = stepCount(article.body);
  const kindLabel = HELP_KINDS.find((k) => k.key === article.kind)?.label ?? "";
  const position = props.siblings.findIndex((a) => a.id === article.id);
  return (
    <article className={`hd-article kind-${article.kind}`} ref={props.refEl}>
      <header className="hd-head hd-rise" style={{ ["--d" as string]: 0 }}>
        <div className="hd-head-ico"><Glyph d={topicPath(article)} size={22} /></div>
        <div className="hd-head-text">
          <div className="hd-path">
            <button type="button" onClick={props.onGroup}><Glyph d={pagePath(article.page)} size={12} />{props.group}</button>
            <span className={`hd-kind kind-${article.kind}`}><Glyph d={kindPath(article.kind)} size={11} />{kindLabel}</span>
          </div>
          <h1>{article.title}</h1>
          <div className="hd-meta">
            {steps > 0 && <span>{steps} steps</span>}
            <span>{readMinutes(article.body)} min read</span>
            {embed && <span className="hd-meta-video">▶ Video</span>}
            {(article.images ?? []).length > 0 && <span>{(article.images ?? []).length} screenshot{(article.images ?? []).length === 1 ? "" : "s"}</span>}
          </div>
        </div>
      </header>

      {embed && (
        <div className="help-video hd-rise" style={{ ["--d" as string]: 1 }}>
          <iframe src={embed} title={article.title} allowFullScreen loading="lazy" />
        </div>
      )}

      {hero && <Shot image={hero} onZoom={props.onZoom} delay={1} hero />}

      <div className="hd-body hd-rise" style={{ ["--d" as string]: 2 }}>
        {article.body.trim() ? <Markdown>{article.body}</Markdown> : <p className="help-muted">No written steps yet.</p>}
      </div>

      {rest.map((image, index) => <Shot key={image.src} image={image} onZoom={props.onZoom} delay={3 + index} />)}

      <div className="hd-foot hd-rise" style={{ ["--d" as string]: 4 }}>
        <div className="hd-rate">
          {props.rating ? (
            <span className="hd-thanks">{props.rating === "up" ? "Glad it helped." : "Thanks. Tell QC Bot what was missing and we'll fix it."}</span>
          ) : (
            <>
              <span>Did this help?</span>
              <button type="button" onClick={() => props.onRate("up")}>👍 Yes</button>
              <button type="button" onClick={() => props.onRate("down")}>👎 Not really</button>
            </>
          )}
        </div>
        {props.editing && (
          <span className="hc-card-tools">
            <button type="button" title="Move up" disabled={position <= 0 || props.saving} onClick={() => props.onMove("up")}>↑</button>
            <button type="button" title="Move down" disabled={position >= props.siblings.length - 1 || props.saving} onClick={() => props.onMove("down")}>↓</button>
            <button type="button" onClick={props.onEdit}>Edit</button>
            <button type="button" className="danger" onClick={props.onDelete}>Delete</button>
          </span>
        )}
      </div>

      <nav className="hd-pn hd-rise" style={{ ["--d" as string]: 5 }} aria-label="More articles">
        {props.prev ? (
          <button type="button" onClick={() => props.onOpen(props.prev!.id)}>
            <small>← Previous</small>
            <span><Glyph d={topicPath(props.prev)} size={13} />{props.prev.title}</span>
          </button>
        ) : <span />}
        {props.next && (
          <button type="button" className="next" onClick={() => props.onOpen(props.next!.id)}>
            <small>Next →</small>
            <span><Glyph d={topicPath(props.next)} size={13} />{props.next.title}</span>
          </button>
        )}
      </nav>
    </article>
  );
}

function Shot({ image, onZoom, delay, hero }: { image: HelpImage; onZoom: (image: HelpImage) => void; delay: number; hero?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <figure className={`hd-shot hd-rise ${hero ? "hero" : ""} ${loaded ? "loaded" : ""}`} style={{ ["--d" as string]: delay }}>
      <button type="button" onClick={() => onZoom(image)} aria-label={`Enlarge screenshot${image.caption ? `: ${image.caption}` : ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.src} alt={image.caption} loading={hero ? "eager" : "lazy"} onLoad={() => setLoaded(true)} />
        <span className="hd-zoom"><Glyph d={EXPAND_PATH} size={13} />Enlarge</span>
      </button>
      {image.caption && <figcaption>{image.caption}</figcaption>}
    </figure>
  );
}

function RailList({ title, items, onOpen }: { title: string; items: HelpArticle[]; onOpen: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="hd-rail-box">
      <span className="hd-eyebrow">{title}</span>
      {items.map((a, i) => (
        <button key={a.id} type="button" className="hd-rail-link" style={{ ["--i" as string]: i }} onClick={() => onOpen(a.id)}>
          <Glyph d={topicPath(a)} size={13} />
          <span>{a.title}</span>
        </button>
      ))}
    </div>
  );
}

function AskBot() {
  return (
    <div className="hd-bot">
      <span className="hd-bot-ico"><Glyph d="M4 5h16v11H9l-5 4z M8 10.5h.01 M12 10.5h.01 M16 10.5h.01" size={16} /></span>
      <strong>Still stuck?</strong>
      <p>Mention <code>@QC Bot</code> in Slack or open MCP. It reads every article here and walks you through it.</p>
      <a href="/mcp">Ask in MCP →</a>
    </div>
  );
}

function HomeView({ loading, articles, groups, onOpen, onSearch }: {
  loading: boolean;
  articles: HelpArticle[];
  groups: Array<{ path: string; label: string; items: HelpArticle[] }>;
  onOpen: (id: string) => void;
  onSearch: () => void;
}) {
  const pick = (ids: string[]) => ids.map((id) => articles.find((a) => a.id === id)).filter((a): a is HelpArticle => Boolean(a));
  const start = pick(["w-getting-around", "w-inbox", "w-ai-draft", "w-follow-ups"]);
  const fixes = articles.filter((a) => a.kind === "troubleshooting").slice(0, 6);
  const withShot = (id: string) => articles.find((a) => a.id === id)?.images?.[0]?.src;
  return (
    <div className="hd-home-view">
      <div className="hd-hero hd-rise" style={{ ["--d" as string]: 0 }}>
        <span className="hd-eyebrow">Help center</span>
        <h1>Everything QC Command does, one click away.</h1>
        <p>{loading ? "Loading guides…" : `${articles.length} short guides, each with a screenshot.`} Pick a page on the left, start below, or press <kbd>/</kbd> to search.</p>
        <button type="button" className="hd-hero-search" onClick={onSearch}><Glyph d={SEARCH_PATH} size={15} />Search help<kbd>/</kbd></button>
      </div>

      {start.length > 0 && (
        <section className="hd-section">
          <span className="hd-eyebrow">Start here</span>
          <div className="hd-start">
            {start.map((a, i) => (
              <button key={a.id} type="button" className="hd-start-card hd-rise" style={{ ["--d" as string]: i + 1 }} onClick={() => onOpen(a.id)}>
                <span className="hd-start-shot">
                  {withShot(a.id) && /* eslint-disable-next-line @next/next/no-img-element */ <img src={withShot(a.id)} alt="" loading="lazy" />}
                </span>
                <span className="hd-start-body">
                  <span className="hd-ico"><Glyph d={topicPath(a)} size={14} /></span>
                  <strong>{a.title}</strong>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="hd-section">
        <span className="hd-eyebrow">Browse by page</span>
        <div className="hd-pages">
          {groups.map((g, i) => (
            <button key={g.path || "general"} type="button" className="hd-page-card hd-rise" style={{ ["--d" as string]: Math.min(i, 10) + 2 }} onClick={() => onOpen(g.items[0].id)}>
              <span className="hd-page-top">
                <span className="hd-ico lg"><Glyph d={pagePath(g.path)} size={17} /></span>
                <small>{g.items.length}</small>
              </span>
              <strong>{g.label}</strong>
              <span className="hd-page-sub">{g.items[0].title}</span>
              <span className="hd-page-kinds">
                {KIND_ORDER.filter((k) => g.items.some((a) => a.kind === k)).map((k) => (
                  <span key={k} className={`hd-mini kind-${k}`} title={HELP_KINDS.find((x) => x.key === k)?.label}><Glyph d={kindPath(k)} size={11} /></span>
                ))}
              </span>
            </button>
          ))}
        </div>
      </section>

      {fixes.length > 0 && (
        <section className="hd-section">
          <span className="hd-eyebrow">Something broken?</span>
          <div className="hd-fixes">
            {fixes.map((a, i) => (
              <button key={a.id} type="button" className="hd-fix hd-rise" style={{ ["--d" as string]: i + 3 }} onClick={() => onOpen(a.id)}>
                <span className="hd-fix-ico"><Glyph d={topicPath(a)} size={14} /></span>
                <span>{a.title}</span>
                <Glyph d={ARROW_PATH} size={14} className="hd-fix-arrow" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
