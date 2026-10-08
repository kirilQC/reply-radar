// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Email Bison, QC's email sending platform (send.qcgrowth.com), as HeyReach is for LinkedIn.
 *
 * ── Keys ────────────────────────────────────────────────────────────────────────────────────────
 * EMAILBISON_API_KEY is a super-admin key and EMAILBISON_BASE_URL the instance. A Bison key acts in one
 * workspace at a time, and moving it ("switch workspace") also moves what that user sees when logged in. So
 * the super-admin key is used only to list workspaces and to mint one workspace-scoped token per client,
 * stored on rr_workspaces.emailbison_token; every read and send for a client uses that client's token.
 *
 * ── What counts ─────────────────────────────────────────────────────────────────────────────────
 * Only "Tracked Reply" rows (a lead in one of our campaigns answering) are replies. The inboxes also collect
 * vendor pitches and cold mail to the sending accounts ("Untracked Reply"), which are never ingested.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

export const BISON_KEY_ENV = "EMAILBISON_API_KEY";
export const BISON_URL_ENV = "EMAILBISON_BASE_URL";

export function bisonConfigured(): boolean {
  return Boolean(text(process.env[BISON_KEY_ENV]) && text(process.env[BISON_URL_ENV]));
}

const baseUrl = () => text(process.env[BISON_URL_ENV]).replace(/\/+$/, "");
const adminKey = () => text(process.env[BISON_KEY_ENV]);

export class BisonError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** One call to the Bison API with a given token. Throws BisonError with Bison's own message. */
export async function bison(token: string, path: string, init: RequestInit = {}): Promise<Row> {
  if (!baseUrl() || !token) throw new BisonError(`${BISON_URL_ENV} and ${BISON_KEY_ENV} must be set.`, 0);
  const response = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const body = await response.text().catch(() => "");
  let data: Row = {};
  try { data = object(JSON.parse(body)); } catch { data = { message: body.slice(0, 200) }; }
  if (!response.ok) {
    const message = text(object(data.data).message) || text(data.message) || `Email Bison answered ${response.status}.`;
    throw new BisonError(message, response.status);
  }
  return data;
}

// ── Workspaces and keys ──────────────────────────────────────────────────────────────────────────

export type BisonWorkspace = { id: number; name: string };

/** Every workspace the super-admin key can see. */
export async function listBisonWorkspaces(): Promise<BisonWorkspace[]> {
  const data = await bison(adminKey(), "/api/workspaces/v1.1");
  return (Array.isArray(data.data) ? (data.data as Row[]) : [])
    .map((row) => ({ id: Number(row.id), name: text(row.name) }))
    .filter((row) => Number.isFinite(row.id) && row.name);
}

/** A new API token scoped to one workspace, minted with the super-admin key. */
export async function mintWorkspaceToken(teamId: number): Promise<string> {
  const data = await bison(adminKey(), `/api/workspaces/v1.1/${teamId}/api-tokens`, { method: "POST", body: JSON.stringify({ name: "QC Command" }) });
  const inner = object(data.data);
  const token = text(inner.plain_text_token) || text(inner.token) || text(data.plain_text_token) || text(data.token);
  if (!token) throw new BisonError("Email Bison created the token but did not return it.", 0);
  return token;
}

/** The workspace Bison names closest to a QC client: exact, then one containing the other ("Ema" ↔ "Ema Health"). */
export function matchBisonWorkspace(clientName: string, workspaces: BisonWorkspace[]): BisonWorkspace | null {
  const wanted = clientName.trim().toLowerCase();
  if (!wanted) return null;
  const exact = workspaces.filter((w) => w.name.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const loose = workspaces.filter((w) => { const name = w.name.toLowerCase(); return name.includes(wanted) || wanted.includes(name); });
  return loose.length === 1 ? loose[0] : null;
}

// ── Replies, threads, sent emails ────────────────────────────────────────────────────────────────

export type BisonReply = Row & { id: number; campaign_id: number | null; lead_id: number | null; type: string; date_received: string };

/** One page of a workspace's inbox replies, newest first. Only tracked replies are kept by the caller. */
export async function listReplies(token: string, page = 1): Promise<{ replies: BisonReply[]; lastPage: number }> {
  const data = await bison(token, `/api/replies?folder=inbox&page=${page}`);
  const meta = object(data.meta);
  return { replies: (Array.isArray(data.data) ? data.data : []) as BisonReply[], lastPage: Number(meta.last_page) || 1 };
}

export async function getReply(token: string, replyId: string | number): Promise<BisonReply | null> {
  try {
    const data = await bison(token, `/api/replies/${encodeURIComponent(String(replyId))}`);
    return object(data.data) as BisonReply;
  } catch (error) {
    if (error instanceof BisonError && error.status === 404) return null;
    throw error;
  }
}

/** Every reply a lead has sent (tracked and not), for building the full thread. */
export async function leadReplies(token: string, leadId: string | number): Promise<BisonReply[]> {
  const data = await bison(token, `/api/leads/${encodeURIComponent(String(leadId))}/replies`);
  return (Array.isArray(data.data) ? data.data : []) as BisonReply[];
}

/** The campaign emails we sent a lead (the outbound half of the thread). */
export async function leadSentEmails(token: string, leadId: string | number): Promise<Row[]> {
  const data = await bison(token, `/api/leads/${encodeURIComponent(String(leadId))}/scheduled-emails`);
  return (Array.isArray(data.data) ? (data.data as Row[]) : []).filter((row) => text(row.status) === "sent" && text(row.sent_at));
}

export async function campaignName(token: string, campaignId: string | number): Promise<string> {
  try {
    const data = await bison(token, `/api/campaigns/${encodeURIComponent(String(campaignId))}`);
    return text(object(data.data).name);
  } catch {
    return "";
  }
}

/** Sends our answer to a reply, from the sending account that received it, quoting the thread. */
export async function sendBisonReply(token: string, replyId: string | number, message: string): Promise<Row> {
  return bison(token, `/api/replies/${encodeURIComponent(String(replyId))}/reply`, {
    method: "POST",
    body: JSON.stringify({ message, reply_all: true, inject_previous_email_body: true, content_type: "text" }),
  });
}

// ── Stats ────────────────────────────────────────────────────────────────────────────────────────

/** Every campaign in the workspace with Bison's running totals (sent, replies, interested, bounced). */
export async function listCampaigns(token: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const data = await bison(token, `/api/campaigns?page=${page}`);
    out.push(...(Array.isArray(data.data) ? (data.data as Row[]) : []));
    if (page >= (Number(object(data.meta).last_page) || 1)) break;
  }
  return out;
}

/** The workspace's activity by day: sent, replied, interested, bounced, opens. */
export async function dailyStats(token: string, startDate: string, endDate: string): Promise<Record<string, Record<string, number>>> {
  const data = await bison(token, `/api/workspaces/v1.1/line-area-chart-stats?start_date=${startDate}&end_date=${endDate}`);
  const byDay: Record<string, Record<string, number>> = {};
  const keyOf: Record<string, string> = { sent: "sent", replied: "replies", interested: "interested", bounced: "bounced", "total opens": "opens" };
  for (const series of Array.isArray(data.data) ? (data.data as Row[]) : []) {
    const key = keyOf[text(series.label).toLowerCase()];
    if (!key) continue;
    for (const point of Array.isArray(series.dates) ? (series.dates as unknown[][]) : []) {
      const day = text(point[0]);
      if (!day) continue;
      byDay[day] = { ...(byDay[day] ?? {}), [key]: Number(point[1]) || 0 };
    }
  }
  return byDay;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────────────────────────

export async function listWebhooks(token: string): Promise<Row[]> {
  const data = await bison(token, "/api/webhook-url");
  return Array.isArray(data.data) ? (data.data as Row[]) : [];
}

/** QC's webhook in one workspace: replies and interested, never the untracked inbox noise. */
export async function createWebhook(token: string, url: string): Promise<string> {
  const data = await bison(token, "/api/webhook-url", {
    method: "POST",
    body: JSON.stringify({ name: "QC Command", url, events: ["lead_replied", "lead_interested"] }),
  });
  return text(object(data.data).id);
}
