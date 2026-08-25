// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The premade "client onboarding update" messages the operator picks from when posting to a client's
 * external Slack channel. These used to be a hardcoded array; they now live in `rr_client_update_templates`
 * so the team can rename them, add their own, and delete ones they never use — from the panel itself.
 *
 * The message body stores a literal `{client}` placeholder rather than a baked-in name, so one template
 * serves every client; the panel swaps `{client}` for the client's name when the operator picks it.
 *
 * Templates are global (not per-client): the same shortlist is offered on every client's onboarding page.
 */

type Row = Record<string, unknown>;

export type ClientTemplate = { id: string; label: string; body: string; sortOrder: number };

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const num = (value: unknown) => (typeof value === "number" ? value : Number(value) || 0);

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function authHeaders(key: string, write = false) {
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (write) headers.Prefer = "return=representation";
  return headers;
}

function fromRow(row: Row): ClientTemplate {
  return { id: str(row.id), label: str(row.label), body: str(row.body), sortOrder: num(row.sort_order) };
}

// The shortlist a brand-new workspace starts with, so the panel is never empty on first use. Seeded into
// the table once (when it has no rows), after which they are ordinary editable/deletable rows.
const DEFAULTS: { label: string; body: string }[] = [
  { label: "Kickoff — we're live", body: "Hi team 👋 We've officially kicked off {client}'s outbound program. Our team is building the target lists and first campaigns now — we'll keep you posted as things go live." },
  { label: "Campaigns launched", body: "Quick update — your first campaigns for {client} are now live and messages are going out. We'll share early numbers as replies start coming in." },
  { label: "First replies in", body: "Good news — the first replies are coming in for {client}. We're qualifying them now and will surface anything that looks like a real opportunity." },
  { label: "Weekly check-in", body: "Weekly update: campaigns for {client} are running smoothly. Here's where things stand this week — happy to jump on a call if you'd like to dig into anything." },
  { label: "Blank message", body: "" },
];

/** Every template, ordered. Seeds the defaults the first time the table is empty, so the panel is never blank. */
export async function listClientTemplates(): Promise<ClientTemplate[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  const read = async () => {
    const response = await fetch(`${url}/rest/v1/rr_client_update_templates?select=id,label,body,sort_order&order=sort_order.asc,created_at.asc`, { headers: authHeaders(key), cache: "no-store" });
    if (!response.ok) return [];
    const body = await response.json().catch(() => []);
    return Array.isArray(body) ? (body as Row[]).map(fromRow) : [];
  };
  const existing = await read();
  if (existing.length > 0) return existing;
  // Empty table → seed the defaults once, then read them back with their generated ids.
  await fetch(`${url}/rest/v1/rr_client_update_templates`, {
    method: "POST", headers: authHeaders(key, true),
    body: JSON.stringify(DEFAULTS.map((d, i) => ({ label: d.label, body: d.body, sort_order: i }))),
  }).catch(() => {});
  return read();
}

/** Add a blank (or provided) template at the end of the list. Returns the created row. */
export async function addClientTemplate(label = "New template", body = ""): Promise<ClientTemplate | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const current = await listClientTemplates();
  const sortOrder = current.reduce((max, t) => Math.max(max, t.sortOrder), -1) + 1;
  const response = await fetch(`${url}/rest/v1/rr_client_update_templates`, {
    method: "POST", headers: authHeaders(key, true),
    body: JSON.stringify({ label, body, sort_order: sortOrder }),
  });
  if (!response.ok) return null;
  const rows = (await response.json().catch(() => [])) as Row[];
  return Array.isArray(rows) && rows[0] ? fromRow(rows[0]) : null;
}

/** Rename a template or change its body. Only the fields passed are touched. */
export async function updateClientTemplate(id: string, patch: { label?: string; body?: string }): Promise<boolean> {
  const { url, key } = config();
  if (!url || !key || !id) return false;
  const body: Row = {};
  if (typeof patch.label === "string") body.label = patch.label;
  if (typeof patch.body === "string") body.body = patch.body;
  if (Object.keys(body).length === 0) return true;
  const response = await fetch(`${url}/rest/v1/rr_client_update_templates?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH", headers: authHeaders(key), body: JSON.stringify(body),
  });
  return response.ok;
}

/** Delete a template for good. */
export async function deleteClientTemplate(id: string): Promise<boolean> {
  const { url, key } = config();
  if (!url || !key || !id) return false;
  const response = await fetch(`${url}/rest/v1/rr_client_update_templates?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE", headers: authHeaders(key),
  });
  return response.ok;
}
