export type AuditDetails = Record<string, unknown>;

type SupabaseConfig = { url?: string; key?: string };

const isUUID = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export async function writeAuditEvent(
  config: SupabaseConfig,
  event: { actor: string; action: string; entityType?: string; entityId?: string; details?: AuditDetails },
) {
  if (!config.url || !config.key) return false;
  try {
    const wsId = event.details?.workspaceId;
    const response = await fetch(`${config.url}/rest/v1/rr_audit_log`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        event_type: event.action,
        actor_type: event.actor ?? "system",
        actor_id: event.entityId ?? null,
        ...(isUUID(wsId) ? { workspace_id: wsId } : {}),
        details: { ...event.details, source: event.actor },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[audit-log] write failed: ${response.status} ${text}`);
    }
    return response.ok;
  } catch {
    // Audit logging must never turn a successful user or ingestion action into a failure.
    return false;
  }
}
