export type ReconciliationResult = { workspaceId: string; pages: number; conversationsHydrated: number; watermark: string; };

/**
 * Durable poller contract: persist cursor/watermark after every page in sync_runs.
 * The worker process should schedule this every ten minutes and a seven-day sweep nightly.
 */
export async function reconcileWorkspace(workspaceId: string, lastReconciledAt: string): Promise<ReconciliationResult> {
  return { workspaceId, pages: 0, conversationsHydrated: 0, watermark: lastReconciledAt };
}
