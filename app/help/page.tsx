// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The Help center: walkthroughs (with Loom videos), FAQ, troubleshooting and support, for teammates
 * who did not build the platform and should not need to.
 *
 * Read-first: by default the page is just search and articles, so it is calm for the people it is for.
 * "Edit help" reveals the add / edit / reorder / delete controls for whoever is writing it. The same
 * articles are what the Slack QC Bot and the MCP assistant read through their help_center tool, so
 * anything written here is also how the bot walks somebody through a task.
 */

import { useEffect, useMemo, useState } from "react";
import AppSidebar from "../components/AppSidebar";
import GlobalAppearanceControl from "../components/GlobalAppearanceControl";
import Crumb from "../components/Crumb";
import Markdown from "../components/Markdown";
import { HELP_KINDS, HELP_PAGES, type HelpArticle, type HelpKind, loomEmbedUrl, pageLabel } from "../lib/help-shared";
import "./help.css";

type Draft = { id?: string; kind: HelpKind; title: string; body: string; loomUrl: string; page: string; keywords: string };

const emptyDraft = (kind: HelpKind): Draft => ({ kind, title: "", body: "", loomUrl: "", page: "", keywords: "" });

const matches = (article: HelpArticle, query: string) => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${article.title} ${article.body} ${article.keywords.join(" ")} ${pageLabel(article.page)}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
};

export default function HelpPage() {
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<HelpKind | "all">("walkthrough");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/help", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload) => {
        if (Array.isArray(payload?.articles)) setArticles(payload.articles);
        if (payload?.ok === false) setError(String(payload.error ?? "Help could not be loaded."));
      })
      .catch(() => setError("Help could not be loaded."))
      .finally(() => setLoading(false));
  }, []);

  // A link like /help#h_abc (which the bot hands out) opens that article and scrolls to it.
  useEffect(() => {
    if (loading || !articles.length) return;
    const id = window.location.hash.replace("#", "");
    const target = articles.find((article) => article.id === id);
    if (!target) return;
    setTab(target.kind);
    setOpenId(target.id);
    setTimeout(() => document.getElementById(target.id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, [loading, articles]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const article of articles) map[article.kind] = (map[article.kind] ?? 0) + 1;
    return map;
  }, [articles]);

  const searching = query.trim().length > 0;
  const shown = articles.filter((article) => (searching || tab === "all" ? true : article.kind === tab) && matches(article, query));

  const post = async (payload: Record<string, unknown>) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/help", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(String(data.error ?? "The change could not be saved."));
      setArticles(data.articles);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    if (!draft || !draft.title.trim()) return;
    const ok = await post({
      action: "save",
      article: { ...draft, keywords: draft.keywords.split(",").map((word) => word.trim()).filter(Boolean) },
    });
    if (ok) setDraft(null);
  };

  const startEdit = (article: HelpArticle) =>
    setDraft({ id: article.id, kind: article.kind, title: article.title, body: article.body, loomUrl: article.loomUrl, page: article.page, keywords: article.keywords.join(", ") });

  const activeKind = HELP_KINDS.find((kind) => kind.key === tab);

  return (
    <div className="app-shell">
      <AppSidebar />
      <section className="main-area">
        <header className="topbar">
          <Crumb trail={[{ label: "Help" }]} />
          <div className="top-actions">
            <button type="button" className={`help-edit-toggle ${editing ? "on" : ""}`} onClick={() => { setEditing((value) => !value); setDraft(null); }}>
              {editing ? "Done editing" : "Edit help"}
            </button>
            <GlobalAppearanceControl />
          </div>
        </header>

        <main className="help-page">
          <div className="help-hero">
            <h1>How can we help?</h1>
            <p>Guides, videos and answers for every part of QC Command. You can also ask QC Bot in Slack. It reads this page.</p>
            <div className="help-search">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M14 14l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search help, e.g. “tag a lead”, “morning brief”, “custom dates”" aria-label="Search help" />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search">✕</button>}
            </div>
          </div>

          {!searching && (
            <div className="help-tabs" role="tablist">
              {HELP_KINDS.map((kind) => (
                <button key={kind.key} type="button" role="tab" aria-selected={tab === kind.key} className={tab === kind.key ? "on" : ""} onClick={() => setTab(kind.key)}>
                  {kind.label}
                  <span>{counts[kind.key] ?? 0}</span>
                </button>
              ))}
              <button type="button" role="tab" aria-selected={tab === "all"} className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
                All<span>{articles.length}</span>
              </button>
            </div>
          )}

          <div className="help-section-head">
            <div>
              <h2>{searching ? `Results for “${query.trim()}”` : activeKind?.label ?? "All articles"}</h2>
              {!searching && activeKind && <p>{activeKind.blurb}</p>}
            </div>
            {editing && !draft && (
              <button type="button" className="help-primary" onClick={() => setDraft(emptyDraft(tab === "all" ? "walkthrough" : tab))}>+ Add article</button>
            )}
          </div>

          {error && <p className="help-error" role="alert">{error}</p>}

          {draft && (
            <div className="help-editor">
              <div className="help-editor-row">
                <label>
                  Section
                  <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as HelpKind })}>
                    {HELP_KINDS.map((kind) => <option key={kind.key} value={kind.key}>{kind.label}</option>)}
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
                <textarea value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} rows={9} placeholder={"1. Open the Inbox\n2. Click a reply\n3. Click + Tag and pick DQ"} />
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
          )}

          {loading ? (
            <div className="help-list">
              {Array.from({ length: 4 }).map((_, index) => <div key={index} className="hc-card hc-card-skeleton"><span className="sk sk-line sk-line-lg" /></div>)}
            </div>
          ) : (
            <div className="help-list">
              {shown.map((article) => {
                const open = openId === article.id;
                const embed = loomEmbedUrl(article.loomUrl);
                const siblings = articles.filter((other) => other.kind === article.kind);
                const position = siblings.findIndex((other) => other.id === article.id);
                return (
                  <article key={article.id} id={article.id} className={`hc-card ${open ? "open" : ""}`}>
                    <button type="button" className="hc-card-head" onClick={() => setOpenId(open ? null : article.id)} aria-expanded={open}>
                      <span className="hc-card-title">{article.title}</span>
                      <span className="hc-card-meta">
                        {(searching || tab === "all") && <span className="help-chip">{HELP_KINDS.find((kind) => kind.key === article.kind)?.label}</span>}
                        {article.page && <span className="help-chip">{pageLabel(article.page)}</span>}
                        {embed && <span className="help-chip help-chip-video">▶ Video</span>}
                        <span className="help-caret" aria-hidden>{open ? "−" : "+"}</span>
                      </span>
                    </button>
                    {open && (
                      <div className="hc-card-body">
                        {embed && (
                          <div className="help-video">
                            <iframe src={embed} title={article.title} allowFullScreen loading="lazy" />
                          </div>
                        )}
                        {article.body.trim() ? <div className="help-markdown"><Markdown>{article.body}</Markdown></div> : <p className="help-muted">No written steps yet.</p>}
                        {(article.images ?? []).map((image) => (
                          <figure key={image.src} className="help-shot">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={image.src} alt={image.caption} loading="lazy" />
                            {image.caption && <figcaption>{image.caption}</figcaption>}
                          </figure>
                        ))}
                        <div className="hc-card-foot">
                          {article.page && <a href={article.page} className="help-link">Open {pageLabel(article.page)} →</a>}
                          {editing && (
                            <span className="hc-card-tools">
                              <button type="button" title="Move up" disabled={position <= 0 || saving} onClick={() => void post({ action: "move", id: article.id, direction: "up" })}>↑</button>
                              <button type="button" title="Move down" disabled={position >= siblings.length - 1 || saving} onClick={() => void post({ action: "move", id: article.id, direction: "down" })}>↓</button>
                              <button type="button" onClick={() => startEdit(article)}>Edit</button>
                              <button type="button" className="danger" onClick={() => { if (window.confirm(`Delete “${article.title}”?`)) void post({ action: "delete", id: article.id }); }}>Delete</button>
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
              {!shown.length && (
                <div className="help-empty">
                  {searching
                    ? <>Nothing matches that yet. Try other words, or ask QC Bot in Slack.</>
                    : editing
                      ? <>No articles here yet. <button type="button" className="help-inline" onClick={() => setDraft(emptyDraft(tab === "all" ? "walkthrough" : tab))}>Add the first one</button></>
                      : <>Nothing here yet. Check back soon.</>}
                </div>
              )}
            </div>
          )}

          {!searching && (tab === "support" || tab === "all") && (
            <div className="help-bot-card">
              <strong>Ask QC Bot</strong>
              <p>Mention <code>@QC Bot</code> in Slack, or open the MCP tab here, and ask in plain words, like “how do I tag a lead?” or “the morning brief didn’t post”. It reads these help articles and will walk you through it, with the video if there is one.</p>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}
