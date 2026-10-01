// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Saved MCP conversations, so a long research session can be picked up again tomorrow or on another
 * machine signed in as the same profile.
 *
 * Stored in rr_app_config (no new table): an index per person at `mcp_sessions:<identity>` holding
 * titles and dates, and one key per conversation at `mcp_session:<identity>:<id>` holding the turns.
 * Listing reads only the index. Attachments the person uploaded are not kept (they were base64 and
 * already sent); files a tool built are kept when they are small enough to be worth re-downloading.
 */

import { NextRequest, NextResponse } from "next/server";
import { deleteConfig, readConfig, writeConfig } from "../../../lib/app-config";

type Meta = { id: string; title: string; updatedAt: string; createdAt: string; turns: number };
type Row = Record<string, unknown>;

const MAX_SESSIONS = 60;
const MAX_FILE_BYTES = 750_000;

const clean = (value: unknown, max = 160) => String(value ?? "").trim().slice(0, max);
const identityOf = (value: unknown) => clean(value, 160).replace(/[^a-zA-Z0-9:_.-]/g, "") || "general";
const idOf = (value: unknown) => clean(value, 60).replace(/[^a-zA-Z0-9_-]/g, "");
const indexKey = (identity: string) => `mcp_sessions:${identity}`;
const bodyKey = (identity: string, id: string) => `mcp_session:${identity}:${id}`;

async function readIndex(identity: string): Promise<Meta[]> {
  const raw = await readConfig(indexKey(identity));
  const list = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
  return Array.isArray(list) ? (list as Meta[]) : [];
}

/** What is worth keeping of a turn. */
function slim(messages: unknown[]): Row[] {
  let fileBudget = MAX_FILE_BYTES;
  return messages.slice(-80).map((m) => {
    const message = { ...(m as Row) };
    if (Array.isArray(message.attached)) message.attached = (message.attached as Row[]).map((a) => ({ name: a.name, mime: a.mime, data: "" }));
    if (Array.isArray(message.files)) {
      message.files = (message.files as Row[]).map((f) => {
        const size = String(f.content ?? "").length;
        if (size <= fileBudget) { fileBudget -= size; return f; }
        return { name: f.name, mime: f.mime, content: "" };
      });
    }
    return message;
  });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const identity = identityOf(params.get("identity"));
  const id = idOf(params.get("id"));
  try {
    if (id) {
      const body = await readConfig(bodyKey(identity, id));
      const session = typeof body === "string" ? JSON.parse(body || "null") : body;
      if (!session) return NextResponse.json({ ok: false, error: "That conversation was not found." }, { status: 404 });
      return NextResponse.json({ ok: true, session });
    }
    const sessions = (await readIndex(identity)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return NextResponse.json({ ok: true, sessions });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Saved conversations are unavailable." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const identity = identityOf(body.identity);
  const id = idOf(body.id);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!id || !messages.length) return NextResponse.json({ ok: false, error: "Nothing to save." }, { status: 400 });
  try {
    const now = new Date().toISOString();
    const index = await readIndex(identity);
    const existing = index.find((s) => s.id === id);
    const firstQuestion = clean((messages.find((m) => (m as Row).role === "user") as Row | undefined)?.content, 90);
    const meta: Meta = {
      id,
      title: clean(body.title, 90) || existing?.title || firstQuestion || "Conversation",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      turns: messages.filter((m) => (m as Row).role === "user").length,
    };
    await writeConfig(bodyKey(identity, id), { ...meta, messages: slim(messages) });
    const next = [meta, ...index.filter((s) => s.id !== id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const dropped = next.slice(MAX_SESSIONS);
    await writeConfig(indexKey(identity), next.slice(0, MAX_SESSIONS));
    await Promise.all(dropped.map((s) => deleteConfig(bodyKey(identity, s.id)).catch(() => undefined)));
    return NextResponse.json({ ok: true, session: meta });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "The conversation could not be saved." }, { status: 502 });
  }
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const identity = identityOf(body.identity);
  const id = idOf(body.id);
  const title = clean(body.title, 90);
  if (!id || !title) return NextResponse.json({ ok: false, error: "A title is needed." }, { status: 400 });
  try {
    const index = await readIndex(identity);
    await writeConfig(indexKey(identity), index.map((s) => (s.id === id ? { ...s, title } : s)));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Rename failed." }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const identity = identityOf(params.get("identity"));
  const id = idOf(params.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "Which conversation?" }, { status: 400 });
  try {
    const index = await readIndex(identity);
    await writeConfig(indexKey(identity), index.filter((s) => s.id !== id));
    await deleteConfig(bodyKey(identity, id)).catch(() => undefined);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Delete failed." }, { status: 502 });
  }
}
