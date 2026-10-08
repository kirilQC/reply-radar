// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The campaign an Email Bison or lemlist reply came from, recorded on the lead the way HeyReach ingestion
 * records it (raw_data.reply_radar.attributions + rollup). rr_leads.campaign_names / sender_names are
 * generated from that rollup, and bookings, deals, cold calling and the database filters read them; without
 * this an email or lemlist lead showed no campaign anywhere but the inbox. Never throws.
 */

import { leadRollup, mergeLeadAttributions } from "./lead-identity";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

export async function attributeLead(
  config: { url: string; key: string },
  leadId: string,
  attribution: { workspaceId: string; workspaceName: string; conversationId: string; campaignId: string; campaignName: string; senderId: string; senderName: string; source: string },
): Promise<void> {
  if (!leadId || !attribution.campaignName) return;
  const headers = { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json" };
  try {
    const response = await fetch(`${config.url}/rest/v1/rr_leads?select=raw_data&id=eq.${encodeURIComponent(leadId)}&limit=1`, { headers, cache: "no-store" });
    const [lead] = response.ok ? ((await response.json()) as Row[]) : [];
    if (!lead) return;
    const raw = object(lead.raw_data);
    const radar = object(raw.reply_radar);
    const attributions = mergeLeadAttributions(radar.attributions, { ...attribution, campaignId: attribution.campaignId || null, senderId: attribution.senderId || null });
    const rollup = leadRollup(attributions);
    await fetch(`${config.url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({ raw_data: { ...raw, client_names: rollup.client_names, campaign_names: rollup.campaign_names, sender_names: rollup.sender_names, reply_radar: { ...radar, attributions, rollup } } }),
      cache: "no-store",
    });
  } catch {
    /* attribution is a convenience: the reply is stored either way */
  }
}
