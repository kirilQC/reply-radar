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

import { useEffect, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

type Props = { value: string; onChange: (markdown: string) => void; placeholder?: string; className?: string };

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

export default function RichNotes({ value, onChange, placeholder = "Everything about this task…", className = "" }: Props) {
  const [linking, setLinking] = useState(false);
  const [href, setHref] = useState("");
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { target: "_blank", rel: "noreferrer" } },
      }),
      Markdown.configure({ html: true, breaks: true, linkify: true, transformPastedText: true, tightLists: true }),
    ],
    content: value,
    editorProps: { attributes: { class: "rn-doc", "data-placeholder": placeholder } },
    onUpdate: ({ editor: e }) => onChange(markdownOf(e)),
  });

  // Keep in step if the task underneath changes while the editor is open.
  useEffect(() => {
    if (!editor || editor.isFocused) return;
    if (markdownOf(editor) !== (value || "").trim()) editor.commands.setContent(value || "");
  }, [editor, value]);

  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const tick = () => force((n) => n + 1);
    editor.on("selectionUpdate", tick);
    editor.on("transaction", tick);
    return () => { editor.off("selectionUpdate", tick); editor.off("transaction", tick); };
  }, [editor]);

  const applyLink = () => {
    if (!editor) return;
    const url = href.trim();
    if (!url) editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: /^(https?:|mailto:)/i.test(url) ? url : `https://${url}` }).run();
    setLinking(false); setHref("");
  };

  const ed = editor;
  const empty = !ed || ed.isEmpty;
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
        <Btn label="Link" title="Link (select text first)" on={ed?.isActive("link") || linking} onClick={() => { setHref(String(ed?.getAttributes("link").href ?? "")); setLinking((v) => !v); }}><Icon d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></Btn>
        {linking && (
          <span className="rn-link">
            <input autoFocus value={href} placeholder="Paste a link, then Enter" onChange={(e) => setHref(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinking(false); }} />
            <button type="button" onMouseDown={(e) => { e.preventDefault(); applyLink(); }}>{href.trim() ? "Apply" : "Remove"}</button>
          </span>
        )}
      </div>
      <div className={`rn-body ${empty ? "rn-empty" : ""}`} onClick={() => ed?.chain().focus().run()}>
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
