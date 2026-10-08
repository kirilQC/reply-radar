// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Email replies into the inbox: one Email Bison reply becomes the same lead / conversation / message rows a
 * HeyReach reply does, with the conversation marked channel = 'email'.
 *
 * ── The thread ──────────────────────────────────────────────────────────────────────────────────
 * A Bison reply's own thread holds only the replies, not the campaign email that started it, so the thread
 * is rebuilt per lead: every campaign email we sent them (outbound) and every reply they sent (inbound),
 * in time order. That ordering is also what tells the inbox we wrote first.
 *
 * ── One person, two channels ────────────────────────────────────────────────────────────────────
 * A lead QC already has from LinkedIn (same name and company in the same client) gets the email
 * conversation on the same lead row, so the inbox, Scout and the rollups see one person. Otherwise a new
 * lead is made, keyed on the email address.
 *
 * Everything is fetched from Bison with the client's own token, never taken from a webhook body, so a
 * forged webhook cannot plant a reply.
 */

import { isOurCampaign } from "../../shared/campaign-code.mjs";
import { emailConversationKey, htmlToText, replyText } from "../../shared/email-text.mjs";
import {
  bisonConfigured,
  campaignName,
  getReply,
  leadReplies,
  leadSentEmails,
  listBisonWorkspaces,
  matchBisonWorkspace,
  mintWorkspaceToken,
  type BisonReply,
} from "./emailbison";

type Row = Record<string, unknown>;
export type Config = { url: string; key: string };
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;

async function rest(config: Config, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  }).catch(() => null);
  if (!response) return { ok: false, status: 0, data: null };
  const body = await response.text().catch(() => "");
  let data: unknown = body;
  try { data = body ? JSON.parse(body) : null; } catch { /* keep text */ }
  return { ok: response.ok, status: response.status, data };
}
async function rows(config: Config, path: string): Promise<Row[]> {
  const result = await rest(config, path);
  if (!result.ok) throw new Error(`Supabase ${path.split("?")[0]} ${result.status}: ${String(typeof result.data === "string" ? result.data : JSON.stringify(result.data)).slice(0, 200)}`);
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

export type EmailWorkspace = { id: string; name: string; slug: string; emailbison_workspace_id?: number | null; emailbison_token?: string | null; offboarded_at?: string | null };
export const EMAIL_WORKSPACE_COLUMNS = "id,name,slug,offboarded_at,emailbison_workspace_id,emailbison_token,emailbison_webhook_id,emailbison_webhook_secret,emailbison_synced_at";

/**
 * The client's Bison workspace and token, linking them on first use: the workspace is matched by name
 * (unless set by hand on the client's page) and a workspace-scoped token minted. Null when Bison is not
 * configured or no single workspace matches; the caller then skips email for this client.
 */
export async function ensureBisonLink(config: Config, workspace: EmailWorkspace): Promise<{ teamId: number; token: string } | null> {
  if (!bisonConfigured()) return null;
  let teamId = Number(workspace.emailbison_workspace_id) || 0;
  let token = text(workspace.emailbison_token);
  if (teamId && token) return { teamId, token };
  if (!teamId) {
    const match = matchBisonWorkspace(workspace.name, await listBisonWorkspaces());
    if (!match) return null;
    teamId = match.id;
  }
  if (!token) token = await mintWorkspaceToken(teamId);
  await rest(config, `rr_workspaces?id=eq.${enc(workspace.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ emailbison_workspace_id: teamId, emailbison_token: token }),
  });
  workspace.emailbison_workspace_id = teamId;
  workspace.emailbison_token = token;
  return { teamId, token };
}

const normal = (value: unknown) => text(value).toLowerCase().replace(/\s+/g, " ");

/** The lead row this Bison lead is: same email, else same name and company (a LinkedIn lead), else a new one. */
async function findOrCreateLead(config: Config, workspaceId: string, lead: Row): Promise<string> {
  const email = text(lead.email).toLowerCase();
  const name = [text(lead.first_name), text(lead.last_name)].filter(Boolean).join(" ") || text(lead.name) || email;
  const company = text(lead.company);
  const ws = `workspace_id=eq.${enc(workspaceId)}`;
  if (email) {
    const byEmail = await rows(config, `rr_leads?select=id&${ws}&raw_data->reply_radar->>email=eq.${enc(email)}&limit=1`);
    if (byEmail[0]) return text(byEmail[0].id);
  }
  if (name && company) {
    const safe = (s: string) => enc(s.replace(/[*%,()]/g, " ").trim());
    const candidates = await rows(config, `rr_leads?select=id,name,company,raw_data&${ws}&name=ilike.${safe(name)}&company=ilike.*${safe(company)}*&limit=3`);
    const same = candidates.find((row) => normal(row.name) === normal(name));
    if (same) {
      // Remember the address on the LinkedIn lead, so the next email from them lands here directly.
      const raw = object(same.raw_data);
      await rest(config, `rr_leads?id=eq.${enc(text(same.id))}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ raw_data: { ...raw, reply_radar: { ...object(raw.reply_radar), email, emailbison: { lead_id: text(lead.id) } } } }),
      });
      return text(same.id);
    }
  }
  const created = await rest(config, "rr_leads", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workspace_id: workspaceId,
      name,
      role: text(lead.title) || null,
      company: company || null,
      raw_data: { email, full_name: name, company_name: company || null, reply_radar: { email, channel: "email", history_status: "complete", emailbison: { lead_id: text(lead.id) } } },
    }),
  });
  const row = Array.isArray(created.data) ? (created.data[0] as Row | undefined) : undefined;
  if (!created.ok || !row) throw new Error(`Could not save the email lead (${created.status}).`);
  return text(row.id);
}

export type EmailIngestResult = { discarded: true; reason: string } | { conversationId: string; leadId: string; messagesWritten: number; campaignName: string };

/**
 * One Bison reply, by id, into the inbox. Re-reads the reply from Bison with the client's token, keeps it
 * only if it is a tracked reply to one of our (coded) campaigns, then writes the lead's whole email thread.
 */
export async function ingestBisonReply(config: Config, workspace: EmailWorkspace, replyId: string | number): Promise<EmailIngestResult> {
  const link = await ensureBisonLink(config, workspace);
  if (!link) return { discarded: true, reason: "no_bison_workspace" };
  const reply = await getReply(link.token, replyId);
  if (!reply) return { discarded: true, reason: "reply_not_found" };
  if (text(reply.type) !== "Tracked Reply" || !reply.lead_id || !reply.campaign_id) return { discarded: true, reason: "untracked" };

  const campaign = await campaignName(link.token, String(reply.campaign_id));
  // The same rule as LinkedIn: a campaign without a QC code is the client's own outreach, not ours.
  if (!isOurCampaign(campaign)) return { discarded: true, reason: "not_our_campaign" };

  const lead = object(reply.lead);
  const leadId = await findOrCreateLead(config, workspace.id, Object.keys(lead).length ? lead : { id: reply.lead_id, email: reply.from_email_address, name: reply.from_name });
  const bisonLeadId = text(reply.lead_id);

  const [sent, replies] = await Promise.all([
    leadSentEmails(link.token, bisonLeadId).catch(() => [] as Row[]),
    leadReplies(link.token, bisonLeadId).catch(() => [] as BisonReply[]),
  ]);
  const allReplies = replies.some((row) => text(row.id) === text(reply.id)) ? replies : [...replies, reply];

  const campaignRef = (id: unknown, name: string) => ({ id: text(id), name, source: "emailbison" });
  const messages = [
    ...sent.map((row) => ({
      heyreach_message_id: `bison:sent:${text(row.id)}`,
      direction: "outbound",
      body: htmlToText(row.email_body),
      sent_at: text(row.sent_at),
      raw_data: { channel: "email", subject: text(row.email_subject), reply_radar: { channel: "email", campaign: campaignRef(row.campaign_id, campaign), sender: { id: text(object(row.sender_email).id), name: text(object(row.sender_email).name) || text(object(row.sender_email).email) }, emailbison: { scheduled_email_id: text(row.id) } } },
    })),
    ...allReplies.filter((row) => text(row.date_received)).map((row) => ({
      heyreach_message_id: `bison:reply:${text(row.id)}`,
      direction: "inbound",
      body: replyText(row),
      sent_at: text(row.date_received),
      raw_data: { channel: "email", subject: text(row.subject), from: text(row.from_email_address), reply_radar: { channel: "email", campaign: campaignRef(row.campaign_id ?? reply.campaign_id, campaign), interested: row.interested === true, automated: row.automated_reply === true, emailbison: { reply_id: text(row.id), sender_email_id: text(row.sender_email_id) } } },
    })),
  ].filter((message) => message.body || message.direction === "inbound");

  const sorted = [...messages].sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at));
  const last = sorted[sorted.length - 1];
  const conversation = await rest(config, "rr_conversations?on_conflict=workspace_id,heyreach_conversation_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      workspace_id: workspace.id,
      lead_id: leadId,
      heyreach_conversation_id: emailConversationKey(bisonLeadId),
      account_id: text(reply.sender_email_id) || null,
      channel: "email",
      last_message_at: last?.sent_at ?? text(reply.date_received),
      last_message_direction: last?.direction ?? "inbound",
      updated_at: new Date().toISOString(),
    }),
  });
  const conversationRow = Array.isArray(conversation.data) ? (conversation.data[0] as Row | undefined) : undefined;
  if (!conversation.ok || !conversationRow) throw new Error(`Could not save the email conversation (${conversation.status}): ${JSON.stringify(conversation.data).slice(0, 200)}`);
  const conversationId = text(conversationRow.id);

  if (sorted.length) {
    const written = await rest(config, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(sorted.map((message) => ({ conversation_id: conversationId, ...message }))),
    });
    if (!written.ok) throw new Error(`Could not save the email messages (${written.status}).`);
  }
  return { conversationId, leadId, messagesWritten: sorted.length, campaignName: campaign };
}

/**
 * The backup to the webhook, and the first backfill: every one of the client's coded campaigns, its replies
 * newest first, any not yet stored ingested. Reading per campaign (not the shared inbox) matters: a sending
 * inbox fills with vendor pitches, and a page of those used to end the read before any real reply was seen.
 * A campaign's paging stops at the first page whose replies are all stored, so a quiet campaign costs one call.
 */
export async function syncBisonReplies(config: Config, workspace: EmailWorkspace, maxPages = 3, full = false): Promise<{ checked: number; ingested: string[]; skipped: Record<string, number> }> {
  const link = await ensureBisonLink(config, workspace);
  if (!link) return { checked: 0, ingested: [], skipped: { no_bison_workspace: 1 } };
  // Why each new reply was not stored, by reason, so a client whose replies never arrive says why.
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  const { listCampaigns, listCampaignReplies } = await import("./emailbison");
  const campaigns = (await listCampaigns(link.token)).filter((row) => isOurCampaign(text(row.name)) && Number(row.unique_replies ?? row.replied ?? 1) > 0);
  const ingested: string[] = [];
  let checked = 0;
  for (const campaign of campaigns) {
    for (let page = 1; page <= maxPages; page += 1) {
      const { replies, lastPage } = await listCampaignReplies(link.token, text(campaign.id), page);
      checked += replies.length;
      let fresh = 0;
      for (const reply of replies) {
        if (!reply.lead_id) { skip("no_lead"); continue; }
        const stored = await rows(config, `rr_messages?select=id&heyreach_message_id=eq.${enc(`bison:reply:${text(reply.id)}`)}&limit=1`);
        if (stored[0]) continue;
        fresh += 1;
        const result = await ingestBisonReply(config, workspace, text(reply.id)).catch((error) => { skip(`error: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); return null; });
        if (result && "conversationId" in result) ingested.push(result.conversationId);
        else if (result && "reason" in result) skip(result.reason);
      }
      // `full` (the one-time backfill) reads every page; the routine pass stops at the first page with nothing new.
      if ((!fresh && !full) || page >= lastPage) break;
    }
  }
  await rest(config, `rr_workspaces?id=eq.${enc(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ emailbison_synced_at: new Date().toISOString() }) });
  return { checked, ingested: [...new Set(ingested)], skipped };
}

/**
 * Our answer to an email conversation, sent through Bison from the inbox that received the lead's latest
 * reply, then stored as the outbound message it is. The inbox and the Slack Send Reply both come here for
 * a `bison:` conversation instead of going to HeyReach.
 */
export async function sendEmailConversationReply(config: Config, conversationId: string, message: string): Promise<{ ok: boolean; status: number; error?: string; sentAt?: string }> {
  const [conversation] = await rows(config, `rr_conversations?select=id,workspace_id,heyreach_conversation_id&id=eq.${enc(conversationId)}&limit=1`);
  if (!conversation) return { ok: false, status: 404, error: "That conversation no longer exists." };
  const [workspace] = await rows(config, `rr_workspaces?select=${EMAIL_WORKSPACE_COLUMNS}&id=eq.${enc(text(conversation.workspace_id))}&limit=1`);
  if (!workspace) return { ok: false, status: 404, error: "The client is gone." };
  const link = await ensureBisonLink(config, workspace as unknown as EmailWorkspace).catch(() => null);
  if (!link) return { ok: false, status: 409, error: "This client is not connected to Email Bison." };
  const [latest] = await rows(config, `rr_messages?select=raw_data,sent_at&conversation_id=eq.${enc(conversationId)}&direction=eq.inbound&order=sent_at.desc&limit=1`);
  const replyId = text(object(object(object(latest?.raw_data).reply_radar).emailbison).reply_id);
  if (!replyId) return { ok: false, status: 409, error: "There is no email reply in this conversation to answer." };
  const { sendBisonReply } = await import("./emailbison");
  try {
    await sendBisonReply(link.token, replyId, message);
  } catch (error) {
    return { ok: false, status: 502, error: `Email Bison did not send it: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  const sentAt = new Date().toISOString();
  await rest(config, "rr_messages?on_conflict=conversation_id,heyreach_message_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ conversation_id: conversationId, heyreach_message_id: `bison:manual:${Date.now()}`, direction: "outbound", body: message, sent_at: sentAt, raw_data: { channel: "email", reply_radar: { channel: "email", sent_from: "qc_command", in_reply_to: replyId } } }),
  });
  await rest(config, `rr_conversations?id=eq.${enc(conversationId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_message_at: sentAt, last_message_direction: "outbound", updated_at: sentAt }) });
  return { ok: true, status: 200, sentAt };
}

/** The inbox's refresh for an email thread: the lead's latest reply re-ingested from Bison. */
export async function refreshEmailConversation(config: Config, conversationId: string): Promise<{ messagesUpdated: number; error?: string }> {
  const [conversation] = await rows(config, `rr_conversations?select=id,workspace_id&id=eq.${enc(conversationId)}&limit=1`);
  if (!conversation) return { messagesUpdated: 0, error: "Conversation not found" };
  const [workspace] = await rows(config, `rr_workspaces?select=${EMAIL_WORKSPACE_COLUMNS}&id=eq.${enc(text(conversation.workspace_id))}&limit=1`);
  const [latest] = await rows(config, `rr_messages?select=raw_data&conversation_id=eq.${enc(conversationId)}&direction=eq.inbound&order=sent_at.desc&limit=1`);
  const replyId = text(object(object(object(latest?.raw_data).reply_radar).emailbison).reply_id);
  if (!workspace || !replyId) return { messagesUpdated: 0, error: "Nothing to refresh from Email Bison." };
  const result = await ingestBisonReply(config, workspace as unknown as EmailWorkspace, replyId);
  await rest(config, `rr_conversations?id=eq.${enc(conversationId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_refreshed_at: new Date().toISOString() }) });
  return "conversationId" in result ? { messagesUpdated: result.messagesWritten } : { messagesUpdated: 0, error: result.reason };
}

/** Email campaign totals and the last 45 days of daily activity for one client, from Bison into QC. */
export async function refreshBisonStats(config: Config, workspace: EmailWorkspace): Promise<{ campaigns: number; days: number }> {
  const link = await ensureBisonLink(config, workspace);
  if (!link) return { campaigns: 0, days: 0 };
  const { dailyStats, listCampaigns } = await import("./emailbison");
  const now = new Date().toISOString();
  const campaigns = await listCampaigns(link.token);
  if (campaigns.length) {
    await rest(config, "rr_email_campaign_stats?on_conflict=workspace_id,campaign_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(campaigns.map((row) => ({
        workspace_id: workspace.id,
        campaign_id: text(row.id),
        name: text(row.name),
        status: text(row.status) || null,
        total_leads: Number(row.total_leads) || 0,
        leads_contacted: Number(row.total_leads_contacted) || 0,
        emails_sent: Number(row.emails_sent) || 0,
        unique_replies: Number(row.unique_replies) || 0,
        interested: Number(row.interested) || 0,
        bounced: Number(row.bounced) || 0,
        unsubscribed: Number(row.unsubscribed) || 0,
        unique_opens: Number(row.unique_opens) || 0,
        created_at: text(row.created_at) || null,
        refreshed_at: now,
      }))),
    });
  }
  const end = new Date();
  const start = new Date(end.getTime() - 45 * 86_400_000);
  const byDay = await dailyStats(link.token, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  const days = Object.entries(byDay);
  if (days.length) {
    await rest(config, "rr_email_daily_stats?on_conflict=workspace_id,day", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(days.map(([day, values]) => ({ workspace_id: workspace.id, day, sent: values.sent ?? 0, replies: values.replies ?? 0, interested: values.interested ?? 0, bounced: values.bounced ?? 0, opens: values.opens ?? 0, refreshed_at: now }))),
    });
  }
  return { campaigns: campaigns.length, days: days.length };
}

/**
 * QC's webhook in the client's Bison workspace, created once. The URL carries a random secret only QC and
 * Bison know, and the receiver re-reads every reply from Bison anyway, so a guessed URL plants nothing.
 */
export async function registerBisonWebhook(config: Config, workspace: EmailWorkspace & { emailbison_webhook_id?: string | null }, baseUrl: string): Promise<{ ok: boolean; webhookId?: string; error?: string }> {
  const link = await ensureBisonLink(config, workspace);
  if (!link) return { ok: false, error: "No single Email Bison workspace matches this client." };
  if (text(workspace.emailbison_webhook_id)) return { ok: true, webhookId: text(workspace.emailbison_webhook_id) };
  const { createWebhook } = await import("./emailbison");
  const { randomBytes } = await import("node:crypto");
  const secret = randomBytes(18).toString("base64url");
  const url = `${baseUrl}/api/webhooks/emailbison/${enc(workspace.slug)}/${secret}`;
  const webhookId = await createWebhook(link.token, url);
  await rest(config, `rr_workspaces?id=eq.${enc(workspace.id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ emailbison_webhook_id: webhookId || "created", emailbison_webhook_secret: secret }) });
  return { ok: true, webhookId };
}
