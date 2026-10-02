// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * "Latest update" on a task: a running feed of short written updates and voice notes, each with who left
 * it. Who you are is picked once and remembered (the same `pm-me` the board uses for "Updated by").
 * Updates post straight away; they don't wait for the task's Save button.
 */

import { useEffect, useRef, useState } from "react";

type Update = { id: string; author: string; text?: string; audioUrl?: string; durationSec?: number; at: string };
type Person = { name: string; avatarUrl?: string | null };

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const hue = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

function Face({ name, url }: { name: string; url?: string }) {
  return <span className="lu-av" style={url ? undefined : { background: `hsl(${hue(name)} 55% 45%)` }}>{url ? <img src={url} alt="" /> : (name.trim()[0] || "?").toUpperCase()}</span>;
}

/** A compact player: play/pause, a progress bar you can click to seek, and the time. */
function VoicePlayer({ src, duration }: { src: string; duration?: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [len, setLen] = useState(duration || 0);
  return (
    <div className="lu-voice">
      <button type="button" className="lu-play" aria-label={playing ? "Pause voice note" : "Play voice note"} onClick={() => { const a = ref.current; if (!a) return; if (a.paused) void a.play(); else a.pause(); }}>
        {playing ? <svg viewBox="0 0 24 24" style={{ width: 13, height: 13 }} aria-hidden><path fill="currentColor" d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
          : <svg viewBox="0 0 24 24" style={{ width: 13, height: 13 }} aria-hidden><path fill="currentColor" d="M8 5v14l11-7z" /></svg>}
      </button>
      <div className="lu-track" onClick={(e) => { const a = ref.current; if (!a || !len) return; const r = e.currentTarget.getBoundingClientRect(); a.currentTime = ((e.clientX - r.left) / r.width) * len; }}>
        <i style={{ width: `${len ? Math.min(100, (t / len) * 100) : 0}%` }} />
      </div>
      <span className="lu-time">{clock(playing || t ? t : len)}</span>
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setT(0); }}
        onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setLen(d); }}
      />
    </div>
  );
}

export default function LatestUpdates({ taskId, people, map }: { taskId: string; people: Person[]; map: Record<string, string> }) {
  const [updates, setUpdates] = useState<Update[] | null>(null);
  const [me, setMe] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Recording state
  const [rec, setRec] = useState<"idle" | "recording" | "review">("idle");
  const [secs, setSecs] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; url: string; secs: number } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const started = useRef(0);

  useEffect(() => { try { setMe(localStorage.getItem("pm-me") || ""); } catch { /* ignore */ } }, []);
  useEffect(() => {
    let live = true;
    void fetch(`/api/project-management/updates?task=${encodeURIComponent(taskId)}`, { cache: "no-store" })
      .then((r) => r.json()).then((p) => { if (live) setUpdates(Array.isArray(p.updates) ? p.updates : []); })
      .catch(() => { if (live) setUpdates([]); });
    return () => { live = false; };
  }, [taskId]);
  useEffect(() => () => { window.clearInterval(timer.current); recorder.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  const pickMe = (name: string) => { setMe(name); setError(""); try { localStorage.setItem("pm-me", name); } catch { /* ignore */ } };
  const needMe = () => { if (me) return false; setError("Pick who you are first."); return true; };

  const postText = async () => {
    const body = text.trim(); if (!body || busy || needMe()) return;
    setBusy(true); setError("");
    const r = await fetch("/api/project-management/updates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task: taskId, author: me, text: body }) }).then((x) => x.json()).catch(() => ({ ok: false }));
    setBusy(false);
    if (r.ok) { setUpdates(r.updates); setText(""); } else setError(r.error || "That update could not be saved.");
  };

  const startRec = async () => {
    if (needMe()) return;
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) || "";
      const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32_000 } : undefined);
      chunks.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: mr.mimeType || "audio/webm" });
        const length = Math.round((Date.now() - started.current) / 1000);
        if (blob.size) { setClip({ blob, url: URL.createObjectURL(blob), secs: length }); setRec("review"); } else setRec("idle");
      };
      recorder.current = mr;
      started.current = Date.now();
      mr.start(250);
      setSecs(0); setRec("recording");
      timer.current = window.setInterval(() => {
        const s = Math.round((Date.now() - started.current) / 1000);
        setSecs(s);
        if (s >= 600) stopRec(); // ten-minute cap
      }, 250);
    } catch {
      setError("The microphone couldn't be opened. Allow microphone access for this site and try again.");
    }
  };
  const stopRec = () => { window.clearInterval(timer.current); if (recorder.current?.state === "recording") recorder.current.stop(); };
  const discard = () => { if (clip) URL.revokeObjectURL(clip.url); setClip(null); setRec("idle"); };
  const sendClip = async () => {
    if (!clip || busy || needMe()) return;
    setBusy(true); setError("");
    const fd = new FormData();
    fd.append("task", taskId); fd.append("author", me); fd.append("duration", String(clip.secs));
    fd.append("file", clip.blob, "voice-note");
    const r = await fetch("/api/project-management/updates", { method: "POST", body: fd }).then((x) => x.json()).catch(() => ({ ok: false }));
    setBusy(false);
    if (r.ok) { setUpdates(r.updates); discard(); } else setError(r.error || "The voice note could not be saved.");
  };
  const remove = async (id: string) => {
    setUpdates((u) => (u || []).filter((x) => x.id !== id));
    await fetch(`/api/project-management/updates?task=${encodeURIComponent(taskId)}&id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  };

  const roster = Array.from(new Set([...people.map((p) => p.name), ...(me ? [me] : [])])).sort((a, b) => a.localeCompare(b));
  return (
    <div className="lu">
      <div className="lu-compose">
        <div className="lu-who">
          <Face name={me || "?"} url={me ? map[me] : undefined} />
          <select value={me} onChange={(e) => pickMe(e.target.value)} aria-label="Who are you?">
            <option value="">Who are you?</option>
            {roster.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        {rec === "recording" ? (
          <div className="lu-rec">
            <span className="lu-rec-dot" />
            <span className="lu-rec-time">{clock(secs)}</span>
            <span className="lu-rec-wave" aria-hidden>{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ animationDelay: `${(i * 83) % 600}ms` }} />)}</span>
            <button type="button" className="lu-btn lu-stop" onClick={stopRec}>Stop</button>
          </div>
        ) : rec === "review" && clip ? (
          <div className="lu-rec lu-review">
            <VoicePlayer src={clip.url} duration={clip.secs} />
            <button type="button" className="lu-btn ghost" onClick={discard} disabled={busy}>Discard</button>
            <button type="button" className="lu-btn" onClick={() => void sendClip()} disabled={busy}>{busy ? "Sending…" : "Send"}</button>
          </div>
        ) : (
          <div className="lu-input">
            <textarea
              rows={1}
              value={text}
              placeholder="What's the latest?"
              onChange={(e) => { setText(e.target.value); e.currentTarget.style.height = "auto"; e.currentTarget.style.height = `${Math.min(120, e.currentTarget.scrollHeight)}px`; }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void postText(); } }}
            />
            <button type="button" className="lu-mic" title="Record a voice note" aria-label="Record a voice note" onClick={() => void startRec()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }} aria-hidden><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /></svg>
            </button>
            <button type="button" className="lu-btn" onClick={() => void postText()} disabled={busy || !text.trim()}>Post</button>
          </div>
        )}
        {error && <p className="lu-error">{error}</p>}
      </div>
      <div className="lu-feed">
        {updates === null ? <p className="lu-empty">Loading updates…</p>
          : updates.length === 0 ? <p className="lu-empty">No updates yet. Post the first one, or record a voice note.</p>
          : updates.map((u) => (
            <div className="lu-item" key={u.id}>
              <Face name={u.author} url={map[u.author]} />
              <div className="lu-body">
                <div className="lu-meta"><b>{u.author}</b><span>{ago(u.at)}</span><button type="button" className="lu-del" title="Delete this update" onClick={() => void remove(u.id)}>✕</button></div>
                {u.text && <p className="lu-text">{u.text}</p>}
                {u.audioUrl && <VoicePlayer src={u.audioUrl} duration={u.durationSec} />}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
