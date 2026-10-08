// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * lemlist, a third outreach source beside HeyReach (LinkedIn) and Email Bison (email). A lemlist campaign can
 * write to a lead by email and on LinkedIn, so its replies land in the inbox on either channel.
 *
 * ── Keys ────────────────────────────────────────────────────────────────────────────────────────
 * A lemlist API key belongs to exactly one lemlist team (account), so each client has its own key, saved on
 * rr_workspaces.lemlist_api_key from the client's Configuration page. Auth is HTTP Basic with an empty user
 * and the key as the password. Docs: https://developer.lemlist.com (base https://api.lemlist.com/api).
 *
 * ── Rate limits ─────────────────────────────────────────────────────────────────────────────────
 * Per key, about 20 requests per 2 seconds. A 429 is waited out once (Retry-After) and tried again.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

const BASE = "https://api.lemlist.com/api";

export class LemlistError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** One call to the lemlist API with a client's key. Throws LemlistError with lemlist's own message. */
export async function lemlist(apiKey: string, path: string, init: RequestInit = {}, retried = false): Promise<unknown> {
  if (!apiKey) throw new LemlistError("No lemlist API key is saved for this client.", 0);
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Basic ${Buffer.from(`:${apiKey}`).toString("base64")}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if (response.status === 429 && !retried) {
    const wait = Math.min(10, Number(response.headers.get("retry-after")) || 2);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return lemlist(apiKey, path, init, true);
  }
  const body = await response.text().catch(() => "");
  let data: unknown = body;
  try { data = body ? JSON.parse(body) : null; } catch { /* plain text */ }
  if (!response.ok) {
    const message = text(object(data).error) || text(object(data).message) || (typeof data === "string" ? data.slice(0, 200) : "") || `lemlist answered ${response.status}.`;
    throw new LemlistError(message, response.status);
  }
  return data;
}

/** The team the key belongs to: proves the key works and names the account on the client's page. */
export async function getTeam(apiKey: string): Promise<{ id: string; name: string }> {
  const team = object(await lemlist(apiKey, "/team"));
  return { id: text(team._id), name: text(team.name) };
}

/** Every campaign in the team, as { id, name }. */
export async function listCampaigns(apiKey: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await lemlist(apiKey, `/campaigns?version=v2&limit=100&page=${page}`);
    const list = Array.isArray(data) ? data : Array.isArray(object(data).campaigns) ? (object(data).campaigns as unknown[]) : [];
    out.push(...list.map((row) => ({ id: text(object(row)._id), name: text(object(row).name) })).filter((row) => row.id));
    const pagination = object(object(data).pagination);
    if (list.length < 100 || (Number(pagination.totalPage ?? pagination.totalPages) || 1) <= page) break;
  }
  return out;
}

/** Reply activities of one type (emailsReplied / linkedinReplied), newest first, from `since` on. */
export async function replyActivities(apiKey: string, type: "emailsReplied" | "linkedinReplied", since: string, maxPages = 5): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const data = await lemlist(apiKey, `/activities?version=v2&type=${type}&limit=100&offset=${page * 100}&minDate=${encodeURIComponent(since)}`);
    const list = (Array.isArray(data) ? data : []).map(object);
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/** Every message exchanged with a contact (all channels), oldest first. */
export async function contactMessages(apiKey: string, contactId: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < 5; page += 1) {
    const data = object(await lemlist(apiKey, `/inbox/${encodeURIComponent(contactId)}?limit=100&offset=${page * 100}`));
    const list = (Array.isArray(data.data) ? data.data : []).map(object);
    out.push(...list);
    if (list.length < 100) break;
  }
  return out.sort((a, b) => Date.parse(text(a.createdAt)) - Date.parse(text(b.createdAt)));
}

/** The contact record (name, job title, company, LinkedIn URL, email), or null. */
export async function getContact(apiKey: string, contactId: string): Promise<Row | null> {
  const data = await lemlist(apiKey, `/contacts?idsOrEmails=${encodeURIComponent(contactId)}`).catch(() => null);
  const list = Array.isArray(data) ? data : Array.isArray(object(data).data) ? (object(data).data as unknown[]) : Array.isArray(object(data).contacts) ? (object(data).contacts as unknown[]) : [];
  const row = object(list[0]);
  return Object.keys(row).length ? row : null;
}

/** Our email answer, threaded onto the lead's reply (`replyToActivityId`), from the mailbox that wrote them. */
export async function sendEmail(apiKey: string, input: { sendUserId: string; sendUserEmail: string; sendUserMailboxId: string; contactId: string; replyToActivityId: string; html: string }): Promise<void> {
  await lemlist(apiKey, "/inbox/email", {
    method: "POST",
    body: JSON.stringify({ sendUserId: input.sendUserId, sendUserEmail: input.sendUserEmail, sendUserMailboxId: input.sendUserMailboxId, contactId: input.contactId, message: input.html, replyToActivityId: input.replyToActivityId || "latest" }),
  });
}

/** Our LinkedIn answer, from the lemlist user whose LinkedIn account wrote to the lead. */
export async function sendLinkedIn(apiKey: string, input: { sendUserId: string; leadId: string; contactId: string; message: string }): Promise<void> {
  await lemlist(apiKey, "/inbox/linkedin", { method: "POST", body: JSON.stringify(input) });
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

export async function listHooks(apiKey: string): Promise<Row[]> {
  const data = await lemlist(apiKey, "/hooks");
  return (Array.isArray(data) ? data : []).map(object);
}

/** One webhook for one event type. lemlist allows a targetUrl once, so each type gets its own URL. */
export async function addHook(apiKey: string, targetUrl: string, type: string, secret: string): Promise<string> {
  const data = object(await lemlist(apiKey, "/hooks", { method: "POST", body: JSON.stringify({ targetUrl, type, secret }) }));
  return text(data._id);
}

export async function deleteHook(apiKey: string, hookId: string): Promise<void> {
  await lemlist(apiKey, `/hooks/${encodeURIComponent(hookId)}`, { method: "DELETE" });
}
