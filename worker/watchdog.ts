export type WorkspaceHealth = { workspaceId: string; lastWebhookReceivedAt: string | null; lastSuccessfulPollAt: string | null; quietPeriodHours: number; };

export function workspaceNeedsAlert(health: WorkspaceHealth, now = Date.now()) {
  const lastSignal = Math.max(Date.parse(health.lastWebhookReceivedAt ?? "1970-01-01"), Date.parse(health.lastSuccessfulPollAt ?? "1970-01-01"));
  return now - lastSignal > health.quietPeriodHours * 60 * 60 * 1000;
}

export function watchdogMessage(health: WorkspaceHealth) { return `Workspace ${health.workspaceId} has not received a webhook or completed a successful poll within its ${health.quietPeriodHours} hour quiet period.`; }
