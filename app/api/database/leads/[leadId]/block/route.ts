// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { deleteLeadsCompletely, relatedLeadIds, selectRows } from "../../../../../lib/lead-deletion";
import { blockProfile } from "../../../../../lib/lead-blocklist";
import { profileKey } from "../../../../../../shared/blocklist.mjs";

/**
 * Block a person: refuse them at ingestion from now on, and remove what is already stored.
 *
 * A block is a delete that sticks. Deleting alone worked and then the next reply rebuilt the whole person
 * — new lead row, new conversation, back in the inbox — so anyone who is not a lead had to be deleted
 * again every week. This writes the decision down first and then clears the records.
 *
 * The order is deliberate. The block is written *before* the delete, so if the delete fails halfway the
 * person is at least blocked and no new replies land; the leftover rows can be deleted again. Deleting
 * first and failing to write the block would leave the original bug exactly as it was.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ leadId: string }> },
) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  }

  const { leadId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
    return NextResponse.json({ ok: false, error: "Invalid lead id." }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";

  try {
    const [lead] = await selectRows(
      url,
      key,
      `rr_leads?select=id,name,linkedin_profile_url&id=eq.${encodeURIComponent(leadId)}&limit=1`,
    );
    if (!lead) return NextResponse.json({ ok: false, error: "Lead not found." }, { status: 404 });

    /*
     * No profile URL, no block. The list is keyed on the LinkedIn profile URL because that is the only
     * identifier that survives the next ingestion — lead ids are recreated. Blocking someone we cannot
     * recognise next time would be a button that claims to work and does not, so it is refused with the
     * reason rather than quietly turning into a delete.
     */
    const blocked = profileKey(lead.linkedin_profile_url);
    if (!blocked) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "This lead has no LinkedIn profile URL, so there is nothing to recognise them by next time. Delete them instead.",
        },
        { status: 422 },
      );
    }

    await blockProfile(url, key, { profileKey: blocked, name: String(lead.name ?? ""), reason });

    // Person-scoped, like the delete: every row sharing this profile URL is the same person.
    const ids = await relatedLeadIds(url, key, leadId);
    const deleted = ids.length
      ? await deleteLeadsCompletely(url, key, ids)
      : { leads: 0, conversations: 0, messages: 0, scores: 0 };

    return NextResponse.json({ ok: true, blocked, deleted });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Block failed" },
      { status: 502 },
    );
  }
}
