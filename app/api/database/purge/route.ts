/**
 * Removes records the inbox already refuses to show. The Render worker calls this hourly.
 *
 * The inbox filters out conversations the lead started, and conversations whose lead row no longer
 * exists. Filtering keeps them off screen but leaves them in the database, where they still cost
 * query time and still show up in exports and counts. This removes them for good.
 *
 * There is no button for it any more, on purpose: leaving it to someone to remember meant the
 * database quietly filled with people who had cold-messaged us. The verdict comes from
 * classifyConversationOrigin, which stores nothing, so tightening that rule is what makes this sweep
 * reach rows a previous version of the rule had waved through — which is exactly what happened to the
 * conversations that were being credited to campaigns they had never been in.
 *
 * A dry run is still the default, because the caller has to be explicit about an irreversible delete,
 * and the same scan that reports the numbers is the one that does the deleting when confirmed.
 */
import { NextResponse } from "next/server";
import { queryByIds } from "../../../lib/chunk-query";
import { dedupeMessages } from "../../../lib/message-dedupe";
import { deleteConversationsCompletely, deleteLeadsCompletely, selectRows } from "../../../lib/lead-deletion";
import { classifyConversationOrigin } from "../../../../shared/conversation-origin.mjs";

type Row = Record<string, unknown>;

// A single run stays well inside a serverless request. When there is more to do the caller is told so
// and can run it again, which is safer than a scan that times out halfway and reports nothing.
const MAX_CONVERSATIONS_PER_RUN = 4_000;
const PAGE = 1_000;

async function readAllConversations(url: string, key: string): Promise<{ rows: Row[]; hasMore: boolean }> {
  const rows: Row[] = [];
  for (let offset = 0; offset < MAX_CONVERSATIONS_PER_RUN; offset += PAGE) {
    // Ordered by id because it is unique: paging by last_message_at would revisit or skip rows
    // wherever two conversations share a timestamp.
    const page = await selectRows(
      url,
      key,
      `rr_conversations?select=id,lead_id,workspace_id&order=id.asc&limit=${PAGE}&offset=${offset}`,
    );
    rows.push(...page);
    if (page.length < PAGE) return { rows, hasMore: false };
  }
  const next = await selectRows(url, key, `rr_conversations?select=id&order=id.asc&limit=1&offset=${MAX_CONVERSATIONS_PER_RUN}`);
  return { rows, hasMore: next.length > 0 };
}

async function readMessages(url: string, key: string, conversationIds: string[]): Promise<Row[]> {
  return queryByIds(conversationIds, 20, async (batch) => {
    const filter = `conversation_id=in.(${batch.map(encodeURIComponent).join(",")})`;
    const collected: Row[] = [];
    // A busy batch can exceed PostgREST's row ceiling, and a truncated thread would hide the message
    // that proves we opened the conversation.
    for (let offset = 0; ; offset += PAGE) {
      const page = await selectRows(
        url,
        key,
        `rr_messages?select=id,conversation_id,direction,body,sent_at,raw_data&${filter}&order=sent_at.asc&limit=${PAGE}&offset=${offset}`,
      );
      collected.push(...page);
      if (page.length < PAGE) return collected;
    }
  });
}

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Row;
  const confirmed = body.confirm === true;

  try {
    const { rows: conversations, hasMore } = await readAllConversations(url, key);
    const leadIds = [...new Set(conversations.map((row) => String(row.lead_id)).filter(Boolean))];
    const leads = await queryByIds(leadIds, 40, (batch) =>
      selectRows(url, key, `rr_leads?select=id,name,raw_data&id=in.(${batch.map(encodeURIComponent).join(",")})`),
    );
    const leadById = new Map(leads.map((row) => [String(row.id), row]));
    const messages = dedupeMessages(await readMessages(url, key, conversations.map((row) => String(row.id))));
    const byConversation = new Map<string, Row[]>();
    for (const message of messages) {
      const id = String(message.conversation_id);
      byConversation.set(id, [...(byConversation.get(id) ?? []), message]);
    }

    const leadInitiated: Row[] = [];
    const orphaned: string[] = [];
    // Leads keeping at least one conversation we opened must survive even if another of their threads
    // came in cold, so the lead row is only removed once nothing of theirs is left.
    const keptByLead = new Map<string, number>();
    for (const conversation of conversations) {
      const leadId = String(conversation.lead_id);
      if (!leadById.has(leadId)) {
        orphaned.push(String(conversation.id));
        continue;
      }
      const verdict = classifyConversationOrigin({
        messages: byConversation.get(String(conversation.id)) ?? [],
        leadRawData: leadById.get(leadId)?.raw_data,
      });
      if (verdict.origin === "inbound_lead") {
        leadInitiated.push(conversation);
        continue;
      }
      keptByLead.set(leadId, (keptByLead.get(leadId) ?? 0) + 1);
    }

    const leadsToDelete = [...new Set(leadInitiated.map((row) => String(row.lead_id)))].filter(
      (leadId) => !keptByLead.has(leadId),
    );
    const conversationsToDelete = [
      ...orphaned,
      // A lead being deleted takes its own conversations with it, so listing them twice would only
      // report the same row as deleted in two places.
      ...leadInitiated.filter((row) => !leadsToDelete.includes(String(row.lead_id))).map((row) => String(row.id)),
    ];

    const preview = {
      scannedConversations: conversations.length,
      leadInitiatedConversations: leadInitiated.length,
      orphanedConversations: orphaned.length,
      leadsToDelete: leadsToDelete.length,
      // Named so a reviewer can recognise them before agreeing to the delete.
      sampleNames: leadInitiated
        .map((row) => String(leadById.get(String(row.lead_id))?.name ?? ""))
        .filter(Boolean)
        .slice(0, 12),
      hasMore,
    };

    if (!confirmed) return NextResponse.json({ ok: true, dryRun: true, ...preview });

    const conversationCounts = await deleteConversationsCompletely(url, key, conversationsToDelete);
    const leadCounts = await deleteLeadsCompletely(url, key, leadsToDelete);
    const deleted = {
      leads: leadCounts.leads,
      conversations: conversationCounts.conversations + leadCounts.conversations,
      messages: conversationCounts.messages + leadCounts.messages,
      scores: conversationCounts.scores + leadCounts.scores,
    };
    console.info("reply_radar_purge", { ...preview, deleted });
    return NextResponse.json({ ok: true, dryRun: false, ...preview, deleted });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Purge failed" },
      { status: 502 },
    );
  }
}
