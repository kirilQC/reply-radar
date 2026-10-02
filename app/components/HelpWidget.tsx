// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * Scout's help bubble, in the bottom-right corner of every page.
 *
 * A small chat for quick help: how things work, fixing problems and quick facts ("how many clients do
 * we have"). It talks to /api/help/ask, which runs Scout with every tool but keeps answers short and
 * hands anything bigger to the Scout tab with a link. Screenshots can be attached to a question.
 *
 * When Scout can't solve something, the bubble's Report to Kiril form sends a bug or feature request,
 * with a screenshot, to the Feedback inbox (and pings Kiril in Slack when that is configured).
 *
 * Before anything is asked it offers the guides for the page you are on. The conversation lasts for the
 * browser tab (sessionStorage), so moving between pages does not wipe it.
 */

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "./Markdown";
import HelpMascot, { MASCOT_NAME } from "./HelpMascot";
import { HELP_PAGES, type HelpArticle, pageLabel } from "../lib/help-shared";
import "./help-widget.css";

type Shot = { name: string; mime: string; data: string; preview: string };
type Offer = { kind: "bug" | "idea"; summary: string };
type Message = { role: "user" | "assistant"; content: string; shots?: string[]; error?: boolean; sent?: boolean; offer?: Offer; offerDone?: boolean };

const STORE = "reply-radar-help-chat:v2";
const GREETED = "reply-radar-help-greeted";
const HIDDEN_ON = ["/login"];
const MAX_BYTES = 4_500_000;

const rootOf = (path: string) => {
  const first = `/${path.split("/").filter(Boolean)[0] ?? ""}`;
  return HELP_PAGES.some((page) => page.path === first) ? first : "/";
};

/** An image file as base64 plus a data URL to preview it. Rejects anything that isn't an image or is too big. */
function readImage(file: File): Promise<Shot> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return reject(new Error("Screenshots need to be PNG, JPG, GIF or WebP."));
    if (file.size > MAX_BYTES) return reject(new Error("That screenshot is too big. Crop it and try again."));
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name || "screenshot.png", mime: file.type, data: url.split(",")[1] ?? "", preview: url });
    };
    reader.onerror = () => reject(new Error("That file couldn't be read."));
    reader.readAsDataURL(file);
  });
}

const Icon = ({ d, size = 15 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} style={{ width: size, height: size }} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const CLIP = "M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8";

export default function HelpWidget() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [shots, setShots] = useState<Shot[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [articles, setArticles] = useState<HelpArticle[] | null>(null);
  const [greet, setGreet] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [report, setReport] = useState<{ kind: "bug" | "idea"; text: string; shot: Shot | null; sending: boolean; error: string }>({ kind: "bug", text: "", shot: null, sending: false, error: "" });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reportFileRef = useRef<HTMLInputElement>(null);
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
    // Screenshots are not kept across pages: they are big, and the answer has already been given.
    try { window.sessionStorage.setItem(STORE, JSON.stringify(messages.slice(-20).map(({ shots: _s, ...m }) => m))); } catch { /* ignore */ }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, reporting]);

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

  const addShots = async (files: FileList | File[] | null) => {
    setNote("");
    for (const file of Array.from(files ?? []).slice(0, 3)) {
      try {
        const shot = await readImage(file);
        setShots((prev) => [...prev, shot].slice(0, 3));
      } catch (error) {
        setNote(error instanceof Error ? error.message : "That file couldn't be added.");
      }
    }
  };

  const ask = async (question: string) => {
    const text = question.trim();
    if ((!text && !shots.length) || busy) return;
    const asked = text || "What's going on in this screenshot?";
    const history = messages.filter((m) => !m.error && !m.sent).map(({ role, content }) => ({ role, content }));
    const attachments = shots.map(({ name, mime, data }) => ({ name, mime, data }));
    setMessages((prev) => [...prev, { role: "user", content: asked, shots: shots.map((s) => s.preview) }]);
    setInput("");
    setShots([]);
    setBusy(true);
    try {
      const response = await fetch("/api/help/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: asked, page: pathname, history, attachments }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        setMessages((prev) => [...prev, { role: "assistant", error: true, content: String(data.error ?? "I couldn't reach my notes just now. Try again, or reach out to Kiril.") }]);
      } else {
        const offer = data.offer && (data.offer.kind === "bug" || data.offer.kind === "idea") ? { kind: data.offer.kind, summary: String(data.offer.summary ?? asked) } as Offer : undefined;
        setMessages((prev) => [...prev, { role: "assistant", content: String(data.answer), offer }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", error: true, content: "I couldn't reach my notes just now. Check your connection and try again, or reach out to Kiril." }]);
    } finally {
      setBusy(false);
    }
  };

  /** Scout spotted a stuck moment or an idea: answering yes opens the note to Kiril, already written. */
  const answerOffer = (index: number, yes: boolean) => {
    const message = messages[index];
    setMessages((prev) => prev.map((m, k) => (k === index ? { ...m, offerDone: true } : m)));
    if (!yes || !message?.offer) return;
    const shot = [...messages.slice(0, index)].reverse().find((m) => m.role === "user" && m.shots?.length)?.shots?.[0];
    setReport({ kind: message.offer.kind, text: message.offer.summary, shot: shot ? { name: "screenshot", mime: "", data: "", preview: shot } : null, sending: false, error: "" });
    setReporting(true);
  };

  const sendReport = async () => {
    if (!report.text.trim() || report.sending) return;
    setReport((r) => ({ ...r, sending: true, error: "" }));
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: report.kind, message: report.text.trim(), page: `Scout help · ${pathname}`, screenshot: report.shot?.preview ?? "" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(String(data.error ?? "It didn't send."));
      setMessages((prev) => [...prev, { role: "assistant", sent: true, content: `Sent to Kiril. He'll work on ${report.kind === "bug" ? "the fix" : "your idea"} and you can follow it in **Configuration → Feedback**.` }]);
      setReport({ kind: "bug", text: "", shot: null, sending: false, error: "" });
      setReporting(false);
    } catch (error) {
      setReport((r) => ({ ...r, sending: false, error: `${error instanceof Error ? error.message : "It didn't send."} Try again, or message Kiril directly.` }));
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
              {(busy || reporting) && <small>{busy ? "Looking it up…" : "Send to Kiril"}</small>}
            </div>
            <button type="button" className="hw-icon" title="New chat" aria-label="New chat" onClick={() => { setMessages([]); setReporting(false); setInput(""); setShots([]); }}>
              <Icon d="M12 5v14 M5 12h14" />
            </button>
            <button type="button" className="hw-icon" title="Close" onClick={() => setOpen(false)}>
              <Icon d="M6 6l12 12 M18 6L6 18" />
            </button>
          </header>

          <div className="hw-list" ref={listRef}>
            <div className="hw-msg bot">
              <p>Hi! I&apos;m {MASCOT_NAME}. Ask me how anything works, a quick question about your data, or tell me what isn&apos;t working. Big answers open in the <a href="/scout">Scout tab</a>.</p>
            </div>
            {!messages.length && !reporting && suggestions.length > 0 && (
              <div className="hw-suggest">
                <span>{`About ${pageLabel(page) || "this page"}`}</span>
                {suggestions.map((a, i) => (
                  <button key={a.id} type="button" style={{ ["--i" as string]: i }} onClick={() => void ask(/\?$/.test(a.title) ? a.title : `${a.title}?`)}>
                    {a.title}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`hw-msg ${m.role === "user" ? "me" : "bot"} ${m.error ? "err" : ""} ${m.sent ? "sent" : ""}`}>
                {m.shots && m.shots.length > 0 && (
                  <div className="hw-msg-shots">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {m.shots.map((src, k) => <img key={k} src={src} alt="Attached screenshot" />)}
                  </div>
                )}
                {m.role === "user" ? <p>{m.content}</p> : <div className="hw-md"><Markdown>{m.content}</Markdown></div>}
                {m.offer && !m.offerDone && (
                  <div className="hw-offer">
                    <span>{m.offer.kind === "idea" ? "Do you want to submit this idea to Kiril?" : "Do you want to submit this to Kiril?"}</span>
                    <div>
                      <button type="button" onClick={() => answerOffer(i, true)}>Yes</button>
                      <button type="button" className="ghost" onClick={() => answerOffer(i, false)}>No thanks</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="hw-msg bot hw-typing" aria-label={`${MASCOT_NAME} is typing`}>
                <i /><i /><i />
              </div>
            )}
            {reporting && (
              <div className="hw-report">
                <p>Check the note, add anything Kiril should know, and attach a screenshot if it helps.</p>
                <div className="hw-report-kinds" role="radiogroup" aria-label="Type">
                  {(["bug", "idea"] as const).map((k) => (
                    <button key={k} type="button" role="radio" aria-checked={report.kind === k} className={report.kind === k ? "on" : ""} onClick={() => setReport((r) => ({ ...r, kind: k }))}>
                      {k === "bug" ? "Something's broken" : "Feature idea"}
                    </button>
                  ))}
                </div>
                <textarea
                  value={report.text}
                  onChange={(event) => setReport((r) => ({ ...r, text: event.target.value }))}
                  placeholder={report.kind === "bug" ? "What were you doing, what did you expect, and what happened instead?" : "What would you like Scout or QC Command to do?"}
                  rows={4}
                  aria-label="Describe it"
                />
                {report.shot ? (
                  <div className="hw-report-shot">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={report.shot.preview} alt="Screenshot to send" />
                    <button type="button" onClick={() => setReport((r) => ({ ...r, shot: null }))}>Remove</button>
                  </div>
                ) : (
                  <button type="button" className="hw-report-attach" onClick={() => reportFileRef.current?.click()}>
                    <Icon d={CLIP} size={13} /> Attach a screenshot
                  </button>
                )}
                <input ref={reportFileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) readImage(file).then((shot) => setReport((r) => ({ ...r, shot, error: "" }))).catch((error) => setReport((r) => ({ ...r, error: error.message })));
                }} />
                {report.error && <p className="hw-report-error">{report.error}</p>}
                <div className="hw-report-actions">
                  <button type="button" className="ghost" onClick={() => setReporting(false)}>Cancel</button>
                  <button type="button" disabled={!report.text.trim() || report.sending} onClick={() => void sendReport()}>
                    {report.sending ? "Sending…" : "Send to Kiril"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {!reporting && (
            <>
              {(shots.length > 0 || note) && (
                <div className="hw-shots">
                  {shots.map((s, i) => (
                    <span key={i} className="hw-shot">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.preview} alt="" />
                      <button type="button" aria-label="Remove screenshot" onClick={() => setShots((prev) => prev.filter((_, k) => k !== i))}>×</button>
                    </span>
                  ))}
                  {note && <small>{note}</small>}
                </div>
              )}
              <form className="hw-input" onSubmit={(event) => { event.preventDefault(); void ask(input); }}>
                <button type="button" className="hw-clip" title="Attach a screenshot" aria-label="Attach a screenshot" onClick={() => fileRef.current?.click()}>
                  <Icon d={CLIP} size={16} />
                </button>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(event) => { void addShots(event.target.files); event.target.value = ""; }} />
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onPaste={(event) => {
                    const images = Array.from(event.clipboardData.files).filter((f) => f.type.startsWith("image/"));
                    if (images.length) { event.preventDefault(); void addShots(images); }
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(input); } }}
                  placeholder={`Ask ${MASCOT_NAME} anything…`}
                  aria-label={`Ask ${MASCOT_NAME}`}
                />
                <button type="submit" className="hw-send" disabled={(!input.trim() && !shots.length) || busy} aria-label="Send">
                  <Icon d="M4 12l16-8-6 16-3-7z M11 13l9-9" size={16} />
                </button>
              </form>
            </>
          )}
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
