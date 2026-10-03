// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Removing a proposal branch that never became a pull request.
 *
 * Kept out of `brain.ts` on purpose: that module has no delete of any kind, and a test holds it to that so
 * nothing on `main` can ever be removed from the app. This is the one exception, and it is fenced to a
 * branch ref this app created itself (`brain/…`), never a file and never a branch a person made.
 */
export async function discardProposalBranch({
  api,
  repo,
  branch,
  headers,
}: {
  api: string;
  repo: string;
  branch: string;
  headers: Record<string, string>;
}): Promise<void> {
  if (!/^brain\/[a-z0-9-]+$/.test(branch)) return;
  await fetch(`${api}/repos/${repo}/git/refs/heads/${branch}`, {
    method: "DELETE",
    headers,
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
}
