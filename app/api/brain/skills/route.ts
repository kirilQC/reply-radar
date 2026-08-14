/**
 * The catalogue of slash commands in the brain.
 *
 * These are the routines the team has already automated, and today you learn one exists by someone
 * mentioning it. Listing them with a sentence each is most of the value; the body is fetched only
 * when someone opens one.
 *
 * Every command is fetched to read its description, which is twenty-odd files — small enough to do on
 * every request and cached by `brainFile` anyway.
 */
import { NextResponse } from "next/server";
import { BRAIN_URL, brainConfigured, brainFiles, brainTree } from "../../../lib/brain";
import { clientLabel, clientsIn, parseSkill, skillClient } from "../../../../shared/brain-structure.mjs";

const COMMANDS = ".claude/commands/";

export async function GET() {
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }
  try {
    const files = await brainTree();
    const paths = files.map((file) => file.path);
    const clients = clientsIn(paths);
    const commandPaths = paths.filter((path) => path.startsWith(COMMANDS) && path.endsWith(".md"));
    const docs = await brainFiles(commandPaths, 8);

    const skills = docs
      .map((doc) => {
        const parsed = parseSkill(doc.path, doc.text) as { name: string; path: string; command: string; blurb: string; lines: number };
        const client = skillClient(parsed.name, clients);
        return { ...parsed, client, clientLabel: client ? clientLabel(client) : "", url: `${BRAIN_URL}/blob/main/${doc.path}` };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ ok: true, repoUrl: BRAIN_URL, skills });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The skills could not be listed." },
      { status: 502 },
    );
  }
}
