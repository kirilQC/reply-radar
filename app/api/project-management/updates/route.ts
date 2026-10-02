// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A task's "Latest update" feed: short written updates and voice notes, each with who left it.
 *
 * Kept in rr_app_config under pm_updates:<task id> (newest first) so it needs no migration. Voice notes
 * are uploaded to a Supabase Storage bucket and the feed keeps their public URL; the path is random, so
 * a note is only reachable from the task it was left on.
 */

import { NextResponse } from "next/server";
import { readConfig, writeConfig } from "../../../lib/app-config";

const PREFIX = "pm_updates:";
const BUCKET = "pm-voice-notes";
const MAX_AUDIO_BYTES = 4_000_000; // About ten minutes of Opus, and under Vercel's request body limit.
const MAX_ITEMS = 200;

export type TaskUpdate = { id: string; author: string; text?: string; audioUrl?: string; durationSec?: number; at: string };

const asList = (v: unknown): TaskUpdate[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && (x.text || x.audioUrl)) as TaskUpdate[] : []);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const clean = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

export async function GET(request: Request) {
  const task = clean(new URL(request.url).searchParams.get("task"), 80);
  if (!task) return NextResponse.json({ ok: false, error: "No task given." }, { status: 400 });
  return NextResponse.json({ ok: true, updates: asList(await readConfig(`${PREFIX}${task}`).catch(() => [])) });
}

async function uploadAudio(file: File): Promise<string> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  // Creating an existing bucket just fails quietly, so this is safe on every upload.
  await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 5_242_880 }) }).catch(() => {});
  const type = (file.type || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") || type.includes("m4a") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("mpeg") ? "mp3" : "webm";
  const path = `notes/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.${ext}`;
  const up = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, { method: "POST", headers: { ...auth, "content-type": type, "x-upsert": "true" }, body: await file.arrayBuffer() });
  if (!up.ok) throw new Error(`The voice note could not be saved (${up.status}).`);
  return `${url}/storage/v1/object/public/${BUCKET}/${path}`;
}

export async function POST(request: Request) {
  let task = "", author = "", text = "", audioUrl = "", durationSec = 0;
  try {
    if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
      const form = await request.formData();
      task = clean(form.get("task"), 80); author = clean(form.get("author"), 80);
      durationSec = Math.max(0, Math.round(Number(form.get("duration")) || 0));
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "The recording was empty." }, { status: 400 });
      if (file.size > MAX_AUDIO_BYTES) return NextResponse.json({ ok: false, error: "That voice note is too long. Keep it under about ten minutes." }, { status: 400 });
      if (!task || !author) return NextResponse.json({ ok: false, error: "Pick who you are first." }, { status: 400 });
      audioUrl = await uploadAudio(file);
    } else {
      const b = await request.json().catch(() => ({}));
      task = clean(b.task, 80); author = clean(b.author, 80); text = clean(b.text, 4000);
      if (!task || !author) return NextResponse.json({ ok: false, error: "Pick who you are first." }, { status: 400 });
      if (!text) return NextResponse.json({ ok: false, error: "Write an update first." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "That update could not be saved." }, { status: 502 });
  }
  const item: TaskUpdate = { id: newId(), author, at: new Date().toISOString(), ...(text ? { text } : {}), ...(audioUrl ? { audioUrl, durationSec } : {}) };
  const list = asList(await readConfig(`${PREFIX}${task}`).catch(() => []));
  const next = [item, ...list].slice(0, MAX_ITEMS);
  await writeConfig(`${PREFIX}${task}`, next);
  return NextResponse.json({ ok: true, update: item, updates: next });
}

export async function DELETE(request: Request) {
  const params = new URL(request.url).searchParams;
  const task = clean(params.get("task"), 80), id = clean(params.get("id"), 40);
  if (!task || !id) return NextResponse.json({ ok: false, error: "Missing task or update." }, { status: 400 });
  const next = asList(await readConfig(`${PREFIX}${task}`).catch(() => [])).filter((u) => u.id !== id);
  await writeConfig(`${PREFIX}${task}`, next);
  return NextResponse.json({ ok: true, updates: next });
}
