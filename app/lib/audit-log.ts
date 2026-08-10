export type AuditDetails = Record<string, unknown>;

type SupabaseConfig = { url?: string; key?: string };

export async function writeAuditEvent(
  config: SupabaseConfig,
  event: { actor: string; action: string; entityType?: string; entityId?: string; details?: AuditDetails },
) {
  if (!config.url || !config.key) return false;
  try {
    const response = await fetch(`${config.url}/rest/v1/rr_audit_log`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "content-type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        actor: event.actor,
        action: event.action,
        entity_type: event.entityType ?? null,
        entity_id: event.entityId ?? null,
        details: event.details ?? {},
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
