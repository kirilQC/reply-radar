import { NextResponse } from "next/server";

type Row = Record<string, unknown>;
const ageMinutes = (value: unknown) => value ? Math.round((Date.now() - new Date(String(value)).getTime()) / 60000) : null;

export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const services = [
    { id: "supabase", label: "Supabase database", configured: Boolean(url && key) },
    { id: "anthropic", label: "Anthropic API", configured: Boolean(process.env.ANTHROPIC_API_KEY) },
    { id: "worker", label: "Worker service", configured: Boolean(process.env.WORKER_SERVICE_URL) },
  ];
  if (!url || !key) return NextResponse.json({ status: "not_configured", services, clients: [] });
  try {
    const response = await fetch(`${url}/rest/v1/workspaces?select=name,slug,heyreach_api_key_ciphertext,last_webhook_received_at,last_successful_poll_at&order=created_at.asc`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (!response.ok) throw new Error("Unable to read workspace heartbeat data");
    const rows = (await response.json()) as Row[];
    const clients = rows.map((row) => {
      const webhookAgeMinutes = ageMinutes(row.last_webhook_received_at);
      const pollAgeMinutes = ageMinutes(row.last_successful_poll_at);
      const keyConfigured = Boolean(row.heyreach_api_key_ciphertext);
      const webhookHealthy = webhookAgeMinutes !== null && webhookAgeMinutes <= 30;
      const pollHealthy = pollAgeMinutes !== null && pollAgeMinutes <= 60;
      return { name: row.name, slug: row.slug, keyConfigured, webhookAgeMinutes, pollAgeMinutes, status: keyConfigured && webhookHealthy && pollHealthy ? "healthy" : keyConfigured ? "attention" : "missing" };
    });
    return NextResponse.json({ status: "live", services, clients, checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ status: "error", services, clients: [] }, { status: 502 });
  }
}
