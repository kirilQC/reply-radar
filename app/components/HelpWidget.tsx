// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The help button in the bottom-right corner of every page.
 *
 * Opens a small chat with the mascot. Questions go to /api/help/ask, which answers from the Help center
 * and links the articles it used. Before anything is asked it offers the guides for the page you are on,
 * so "how does this work?" is one click. The conversation lasts for the browser tab (sessionStorage), so
 * moving between pages does not wipe it.
 */

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";
import HelpMascot, { MASCOT_NAME } from "./HelpMascot";
import { HELP_PAGES, type HelpArticle, pageLabel } from "../lib/help-shared";
import "./help-widget.css";

type Source = { title: string; url: string; kind: string };
type Message = { role: "user" | "assistant"; content: string; sources?: Source[]; error?: boolean };

const STORE = "reply-radar-help-chat";
const GREETED = "reply-radar-help-greeted";
const HIDDEN_ON = ["/login"];

const rootOf = (path: string) => {
  const first = `/${path.split("/").filter(Boolean)[0] ?? ""}`;
  return HELP_PAGES.some((page) => page.path === first) ? first : "/";
};

export default function HelpWidget() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [greet, setGreet] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const page = rootOf(pathname);
  const hidden = HIDDEN_ON.some((path) => pathname.startsWith(path));

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(STORE);
      if (saved) setMessages(JSON.parse(saved));
      if (!window.sessionStorage.getItem(GREETED)) {
        const show = window.setTimeout(() => setGreet(true), 2500);
        const hide = window.setTimeout(() => setGreet(false), 9500);
        window.sessionStorage.setItem(GREETED, "1");
        return () => { window.clearTimeout(show); window.clearTimeout(hide); };
      }
    } catch { /* private window: start fresh */ }
  }, []);

  useEffect(() => {
    try { window.sessionStorage.setItem(STORE, JSON.stringify(messages.slice(-20))); } catch { /* ignore */ }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (!open) return;
    setGreet(false);
    window.setTimeout(() => inputRef.current?.focus(), 250);
    if (!articles) {
      void fetch("/api/help", { cache: "no-store" })
        .then((response) => response.json())
        .then((payload) => setArticles(Array.isArray(payload?.articles) ? payload.articles : []))
        .catch(() => setArticles([]));
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, articles]);

  /** Guides for the page you are on, how-tos first. */
  const suggestions = useMemo(() => {
    const list = articles ?? [];
    const here = list.filter((a) => a.page === page);
    const pool = here.length ? here : list.filter((a) => a.id === "w-getting-around" || a.kind === "troubleshooting");
    return [...pool].sort((a, b) => (a.kind === "walkthrough" ? 0 : 1) - (b.kind === "walkthrough" ? 0 : 1)).slice(0, 3);
  }, [articles, page]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const history = messages.filter((m) => !m.error).map(({ role, content }) => ({ role, content }));
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setBusy(true);
    try {
      const response = await fetch("/api/help/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text, page: pathname, history }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        setMessages((prev) => [...prev, { role: "assistant", error: true, content: String(data.error ?? "I couldn't reach my notes just now. Try again in a moment."), sources: data.sources }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: String(data.answer), sources: data.sources }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", error: true, content: "I couldn't reach my notes just now. Check your connection and try again." }]);
    } finally {
      setBusy(false);
    }
  };

  if (hidden) return null;

  return (
    <div className={`hw ${open ? "open" : ""}`}>
      {open && (
        <section className="hw-panel" role="dialog" aria-label={`Ask ${MASCOT_NAME}`}>
          <header className="hw-head">
            <span className="hw-head-mascot"><HelpMascot size={38} thinking={busy} /></span>
            <div className="hw-head-text">
              <strong>{MASCOT_NAME}</strong>
              <small>{busy ? "Looking it up…" : "QC Command help"}</small>
            </div>
            {messages.length > 0 && (
              <button type="button" className="hw-icon" title="Start over" onClick={() => setMessages([])}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 12a8 8 0 1 0 2.3-5.7 M4 4v4h4" /></svg>
              </button>
            )}
            <a className="hw-icon" href="/help" title="Open the Help center">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z M4 20V5" /></svg>
            </a>
            <button type="button" className="hw-icon" title="Close" onClick={() => setOpen(false)}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12 M18 6L6 18" /></svg>
            </button>
          </header>

          <div className="hw-list" ref={listRef}>
            <div className="hw-msg bot">
              <p>Hi! I&apos;m {MASCOT_NAME}. Ask me how anything in QC Command works, or tell me what isn&apos;t working.</p>
            </div>
            {!messages.length && suggestions.length > 0 && (
              <div className="hw-suggest">
                <span>{page !== "/" || pathname === "/" ? `About ${pageLabel(page) || "this page"}` : "Popular"}</span>
                {suggestions.map((a, i) => (
                  <button key={a.id} type="button" style={{ ["--i" as string]: i }} onClick={() => void ask(`${a.title}?`.replace(/\?\?$/, "?"))}>
                    {a.title}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`hw-msg ${m.role === "user" ? "me" : "bot"} ${m.error ? "err" : ""}`}>
                {m.role === "user" ? <p>{m.content}</p> : <div className="hw-md"><Markdown>{m.content}</Markdown></div>}
                {m.sources && m.sources.length > 0 && (
                  <div className="hw-sources">
                    {m.sources.map((s) => (
                      <a key={s.url} href={s.url}>
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z M4 20V5" /></svg>
                        {s.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="hw-msg bot hw-typing" aria-label={`${MASCOT_NAME} is typing`}>
                <i /><i /><i />
              </div>
            )}
          </div>

          <form className="hw-input" onSubmit={(event) => { event.preventDefault(); void ask(input); }}>
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(input); } }}
              placeholder={`Ask ${MASCOT_NAME} anything…`}
              aria-label={`Ask ${MASCOT_NAME}`}
            />
            <button type="submit" disabled={!input.trim() || busy} aria-label="Send">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l16-8-6 16-3-7z M11 13l9-9" /></svg>
            </button>
          </form>
        </section>
      )}

      {greet && !open && (
        <button type="button" className="hw-greet" onClick={() => setOpen(true)}>
          Need a hand? Ask me how anything works.
        </button>
      )}

      <button type="button" className="hw-launch" onClick={() => setOpen((v) => !v)} aria-label={open ? "Close help" : `Ask ${MASCOT_NAME} for help`} aria-expanded={open}>
        <HelpMascot size={40} thinking={busy} />
      </button>
    </div>
  );
}
