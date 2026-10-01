// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Inbox tags: the shared vocabulary and who it is hung on.
 *
 * GET returns the tag list. POST carries an `action` because the five things a tag popover does — make a
 * tag, rename one, recolour one, delete one, and tag or untag a conversation — are small variations on the
 * same write and not worth five routes. The definitions live in rr_app_config and the assignments in
 * rr_inbox_tag_assignments; see app/lib/inbox-tags.ts for why they are stored apart.
 */

import { NextResponse } from "next/server";
import { explainConfigError } from "../../../lib/app-config";
import {
  assignTag,
  createTag,
  deleteTag,
  INBOX_TAGS_MIGRATION,
  readTags,
  unassignTag,
  updateTag,
} from "../../../lib/inbox-tags";

type Body = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export async function GET() {
  try {
    return NextResponse.json({ ok: true, tags: await readTags() });
  } catch (error) {
    return NextResponse.json({ ok: false, tags: [], error: explainConfigError(error, "Tags could not be loaded.") }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const action = text(body.action);
  try {
    if (action === "create") {
      const tag = await createTag(text(body.name), text(body.color));
      return NextResponse.json({ ok: true, tag, tags: await readTags() });
    }
    if (action === "update") {
      const id = text(body.id);
      if (!id) return NextResponse.json({ ok: false, error: "Which tag?" }, { status: 400 });
      const tags = await updateTag(id, {
        name: body.name === undefined ? undefined : text(body.name),
        color: body.color === undefined ? undefined : text(body.color),
      });
      return NextResponse.json({ ok: true, tags });
    }
    if (action === "delete") {
      const id = text(body.id);
      if (!id) return NextResponse.json({ ok: false, error: "Which tag?" }, { status: 400 });
      return NextResponse.json({ ok: true, tags: await deleteTag(id) });
    }
    if (action === "assign" || action === "unassign") {
      const conversationId = text(body.conversationId);
      const tagId = text(body.tagId);
      if (!conversationId || !tagId) return NextResponse.json({ ok: false, error: "A conversation and a tag are both required." }, { status: 400 });
      if (action === "assign") await assignTag(conversationId, tagId);
      else await unassignTag(conversationId, tagId);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: explainConfigError(error, "The tag change could not be saved.") + ` (If the table is missing, run ${INBOX_TAGS_MIGRATION}.)` },
      { status: 502 },
    );
  }
}
