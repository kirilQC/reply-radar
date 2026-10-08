// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * A rich-text notes box: bold, italic, underline, headings, bullet and numbered lists, and links.
 *
 * Stored as Markdown, not HTML, because the same text is read by QC Bot, posted to Slack and shown as a
 * one-line preview on cards, and Markdown stays readable in all three. Old plain-text notes load as they
 * are (single line breaks are kept). Underline has no Markdown form, so it is kept as <u>…</u>.
 */

import { useEffect, useRef, useState } from "react";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

type Props = { value: string; onChange: (markdown: string) => void; placeholder?: string; className?: string; uploadUrl?: string };

/**
 * Every line its own paragraph. Notes written before the editor existed (and notes saved by its first
 * version) separate lines with single line breaks, which the editor read as soft breaks inside one big
 * paragraph: bulleting or heading one line then changed all of them. Hard breaks (`\` + newline) and
 * lone newlines between ordinary lines become paragraph breaks; list items and their nesting are left as
 * they are.
 */
const isListLine = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
export const normalizeNotes = (md: string): string => {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").replace(/\\\n/g, "\n").replace(/ {2,}\n/g, "\n").split("\n");
  const out: string[] = [];
  lines.forEach((line, i) => {
    out.push(line);
    const next = lines[i + 1];
    if (next === undefined || !line.trim() || !next.trim()) return;
    if (isListLine(line) && (isListLine(next) || /^\s{2,}\S/.test(next))) return;
    out.push("");
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

const markdownOf = (editor: Editor): string =>
  ((editor.storage as unknown as { markdown?: { getMarkdown: () => string } }).markdown?.getMarkdown() ?? "").trim();

function Btn({ on, label, title, onClick, children }: { on?: boolean; label: string; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={`rn-btn ${on ? "on" : ""}`}
      aria-label={label}
      aria-pressed={on}
      title={title}
      // mousedown, not click, so the editor keeps its selection while the button is pressed.
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
    >
      {children}
    </button>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }} aria-hidden>
    <path d={d} />
  </svg>
);

/** Shift+Enter starts a new paragraph too (or a new list item), never a soft line break inside one. */
const NoSoftBreaks = Extension.create({
  name: "noSoftBreaks",
  addKeyboardShortcuts() {
    return {
      "Shift-Enter": () => this.editor.commands.first(({ commands }) => [() => commands.splitListItem("listItem"), () => commands.splitBlock()]),
    };
  },
});

const isUrl = (s: string) => /^(https?:\/\/|www\.)\S+$/i.test(s.trim());
const asHref = (s: string) => { const u = s.trim(); return /^(https?:|mailto:)/i.test(u) ? u : `https://${u}`; };
const shortUrl = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, "")}${x.pathname.length > 1 ? x.pathname : ""}`.slice(0, 48); } catch { return u.slice(0, 48); } };

export default function RichNotes({ value, onChange, placeholder = "Everything about this task…", className = "", uploadUrl }: Props) {
  // One small panel under the toolbar at a time: a link (text + URL) or an attachment (title + file).
  const [panel, setPanel] = useState<null | "link" | "file">(null);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [fileTitle, setFileTitle] = useState("");
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const savedRange = useRef<{ from: number; to: number } | null>(null);

  /** Uploads each file and drops a "📎 title" link to it where the cursor was. */
  const attach = async (files: File[], title = "") => {
    if (!uploadUrl || !files.length) return;
    setUploadError("");
    for (const file of files) {
      setUploading((n) => n + 1);
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch(uploadUrl, { method: "POST", body: fd }).then((x) => x.json()).catch(() => ({ ok: false }));
      setUploading((n) => n - 1);
      if (!r.ok) { setUploadError(r.error || `${file.name} could not be uploaded.`); continue; }
      const label = `📎 ${(files.length === 1 && title.trim()) || file.name}`;
      const ed = editorRef.current; if (!ed) continue;
      const at = savedRange.current;
      const chain = ed.chain().focus();
      (at ? chain.insertContentAt(at, [{ type: "text", text: label, marks: [{ type: "link", attrs: { href: r.url } }] }, { type: "text", text: " " }]) : chain.insertContent([{ type: "text", text: label, marks: [{ type: "link", attrs: { href: r.url } }] }, { type: "text", text: " " }])).run();
      savedRange.current = null;
    }
  };

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        hardBreak: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: false, HTMLAttributes: { target: "_blank", rel: "noreferrer" } },
      }),
      NoSoftBreaks,
      Markdown.configure({ html: true, breaks: false, linkify: true, transformPastedText: true, tightLists: true }),
    ],
    content: normalizeNotes(value),
    editorProps: {
      attributes: { class: "rn-doc", "data-placeholder": placeholder },
      handlePaste: (view, event) => {
        // Paste a URL over selected text and the text becomes that link.
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const { empty } = view.state.selection;
        if (!empty && isUrl(text)) { editorRef.current?.chain().focus().extendMarkRange("link").setLink({ href: asHref(text) }).run(); return true; }
        // Paste or drop files straight into the notes to attach them.
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!uploadUrl || !files.length) return false;
        event.preventDefault(); void attach(files); return true;
      },
      handleDrop: (_view, event) => { const files = Array.from((event as DragEvent).dataTransfer?.files ?? []); if (!uploadUrl || !files.length) return false; event.preventDefault(); void attach(files); return true; },
      // A click on a link or an attached file opens it in a new tab (a file the browser cannot show is
      // downloaded). To edit a link, put the cursor in it with the arrow keys, or select it and use the
      // link button: the bar with Edit / Remove appears either way.
      // (The opening itself happens on the wrapper's mousedown, below; this only stops the editor moving the
      // cursor into the link on the same click.)
      handleClick: (_view, _pos, event) => Boolean((event.target as HTMLElement | null)?.closest?.("a[href]")),
    },
    onUpdate: ({ editor: e }) => onChange(markdownOf(e)),
  });

  useEffect(() => { editorRef.current = editor; }, [editor]);

  // Keep in step if the task underneath changes while the editor is open.
  useEffect(() => {
    if (!editor || editor.isFocused || panel) return;
    if (markdownOf(editor) !== normalizeNotes(value || "")) editor.commands.setContent(normalizeNotes(value || ""));
  }, [editor, value, panel]);

  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const tick = () => force((n) => n + 1);
    editor.on("selectionUpdate", tick);
    editor.on("transaction", tick);
    return () => { editor.off("selectionUpdate", tick); editor.off("transaction", tick); };
  }, [editor]);

  const ed = editor;
  const selectedText = () => { if (!ed) return ""; const { from, to } = ed.state.selection; return ed.state.doc.textBetween(from, to, " "); };

  const openLinkPanel = () => {
    if (!ed) return;
    if (ed.isActive("link")) ed.chain().focus().extendMarkRange("link").run();
    const { from, to } = ed.state.selection;
    savedRange.current = { from, to };
    setLinkText(selectedText());
    setLinkUrl(String(ed.getAttributes("link").href ?? ""));
    setPanel((p) => (p === "link" ? null : "link"));
  };
  const applyLink = () => {
    if (!ed) return;
    const url = linkUrl.trim();
    const range = savedRange.current ?? { from: ed.state.selection.from, to: ed.state.selection.to };
    if (!url) { ed.chain().focus().setTextSelection(range).extendMarkRange("link").unsetLink().run(); }
    else {
      const current = ed.state.doc.textBetween(range.from, range.to, " ");
      const text = linkText.trim() || current || url;
      if (text !== current) ed.chain().focus().insertContentAt(range, [{ type: "text", text, marks: [{ type: "link", attrs: { href: asHref(url) } }] }]).run();
      else ed.chain().focus().setTextSelection(range).setLink({ href: asHref(url) }).run();
    }
    savedRange.current = null; setPanel(null); setLinkText(""); setLinkUrl("");
  };
  const openFilePanel = () => {
    if (!ed) return;
    const { from, to } = ed.state.selection;
    savedRange.current = { from, to };
    setFileTitle(selectedText());
    setPanel((p) => (p === "file" ? null : "file"));
  };

  const empty = !ed || ed.isEmpty;
  const onLink = !!ed && ed.isActive("link") && !panel;
  const linkHref = onLink ? String(ed!.getAttributes("link").href ?? "") : "";
  return (
    <div className={`rn ${className}`}>
      <div className="rn-bar" role="toolbar" aria-label="Formatting">
        <Btn label="Bold" title="Bold (⌘B)" on={ed?.isActive("bold")} onClick={() => ed?.chain().focus().toggleBold().run()}><b>B</b></Btn>
        <Btn label="Italic" title="Italic (⌘I)" on={ed?.isActive("italic")} onClick={() => ed?.chain().focus().toggleItalic().run()}><i>I</i></Btn>
        <Btn label="Underline" title="Underline (⌘U)" on={ed?.isActive("underline")} onClick={() => ed?.chain().focus().toggleUnderline().run()}><u>U</u></Btn>
        <span className="rn-sep" />
        <Btn label="Heading" title="Heading" on={ed?.isActive("heading", { level: 2 })} onClick={() => ed?.chain().focus().toggleHeading({ level: 2 }).run()}>H1</Btn>
        <Btn label="Subheading" title="Subheading" on={ed?.isActive("heading", { level: 3 })} onClick={() => ed?.chain().focus().toggleHeading({ level: 3 }).run()}>H2</Btn>
        <span className="rn-sep" />
        <Btn label="Bullet list" title="Bullet list" on={ed?.isActive("bulletList")} onClick={() => ed?.chain().focus().toggleBulletList().run()}><Icon d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></Btn>
        <Btn label="Numbered list" title="Numbered list" on={ed?.isActive("orderedList")} onClick={() => ed?.chain().focus().toggleOrderedList().run()}><Icon d="M10 6h10M10 12h10M10 18h10M4 5h1v4M4 9h2M4 15.5c0-.8 2-.8 2 0s-2 1.5-2 2.5h2" /></Btn>
        <span className="rn-sep" />
        <Btn label="Link" title="Add a link (select text first, or type the link's text)" on={ed?.isActive("link") || panel === "link"} onClick={openLinkPanel}><Icon d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></Btn>
        {uploadUrl && <Btn label="Attach a file" title="Attach a file (or paste / drop it in)" on={panel === "file"} onClick={openFilePanel}><Icon d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></Btn>}
        {uploading > 0 && <span className="rn-status">Uploading…</span>}
        {uploadError && <span className="rn-status rn-err" title={uploadError}>{uploadError}</span>}
      </div>

      {panel === "link" && (
        <div className="rn-panel">
          <input value={linkText} placeholder="Text to show" onChange={(e) => setLinkText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setPanel(null); }} />
          <input autoFocus value={linkUrl} placeholder="Paste the link" onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setPanel(null); }} />
          <button type="button" className="rn-go" onClick={applyLink}>{linkUrl.trim() ? "Apply" : "Remove link"}</button>
          <button type="button" className="rn-x" aria-label="Cancel" onClick={() => setPanel(null)}>✕</button>
        </div>
      )}
      {panel === "file" && uploadUrl && (
        <div className="rn-panel">
          <input autoFocus value={fileTitle} placeholder="Title (optional, uses the file name)" onChange={(e) => setFileTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); fileInput.current?.click(); } if (e.key === "Escape") setPanel(null); }} />
          <button type="button" className="rn-go" onClick={() => fileInput.current?.click()}>Choose file…</button>
          <button type="button" className="rn-x" aria-label="Cancel" onClick={() => setPanel(null)}>✕</button>
          <input ref={fileInput} type="file" hidden onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ""; const t = fileTitle; setPanel(null); setFileTitle(""); void attach(f, t); }} />
        </div>
      )}
      {onLink && linkHref && (
        <div className="rn-linkbar">
          <span className="rn-linkbar-url" title={linkHref}>🔗 {shortUrl(linkHref)}</span>
          <a className="rn-linkbar-btn" href={linkHref} target="_blank" rel="noreferrer">Open ↗</a>
          <button type="button" className="rn-linkbar-btn" onMouseDown={(e) => { e.preventDefault(); openLinkPanel(); }}>Edit</button>
          <button type="button" className="rn-linkbar-btn" onMouseDown={(e) => { e.preventDefault(); ed?.chain().focus().extendMarkRange("link").unsetLink().run(); }}>Remove</button>
        </div>
      )}

      <div
        className={`rn-body ${empty ? "rn-empty" : ""}`}
        // Caught here, before the editor sees it: a click on a link or attached file opens it in a new tab
        // (the browser downloads what it cannot show). The editor's own click hook proved unreliable inside
        // contenteditable, where Chrome never follows a link itself.
        onMouseDownCapture={(e) => {
          const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
          if (!a || e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          window.open(a.href, "_blank", "noopener");
        }}
        onClick={(e) => { if (!(e.target as HTMLElement | null)?.closest?.("a[href]")) ed?.chain().focus().run(); }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

/** Markdown notes as one line of plain text, for card previews and anywhere formatting can't show. */
export const plainNotes = (md?: string | null): string =>
  String(md ?? "")
    .replace(/<\/?u>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
