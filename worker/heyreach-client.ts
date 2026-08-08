type RequestOptions = RequestInit & { retryCount?: number };

export class HeyReachClient {
  private readonly base: string;
  private readonly apiKey: string;
  private nextAvailableAt = 0;
  private failureCount = 0;
  constructor(apiKey: string, base = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public/") { this.apiKey = apiKey; this.base = base.replace(/\/$/, ""); }
  private async waitForRateLimit() { const now = Date.now(); if (now < this.nextAvailableAt) await new Promise((resolve) => setTimeout(resolve, this.nextAvailableAt - now)); this.nextAvailableAt = Date.now() + 205; }
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    await this.waitForRateLimit();
    const started = Date.now();
    const response = await fetch(`${this.base}/${path.replace(/^\//, "")}`, { ...options, headers: { ...options.headers, "X-API-KEY": this.apiKey, "content-type": "application/json" } });
    console.info("heyreach_api_call", { path, status: response.status, latencyMs: Date.now() - started });
    if ((response.status === 429 || response.status >= 500) && (options.retryCount ?? 0) < 4) { this.failureCount++; await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (options.retryCount ?? 0) + Math.random() * 250)); return this.request<T>(path, { ...options, retryCount: (options.retryCount ?? 0) + 1 }); }
    const responseText = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) throw new Error(`HeyReach request failed (${response.status}): ${responseText.slice(0, 500) || "empty response"}`);
    this.failureCount = 0;
    if (!responseText.trim()) return undefined as T;
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new Error(`HeyReach returned ${contentType || "an unknown content type"}: ${responseText.slice(0, 500)}`);
    }
    try { return JSON.parse(responseText) as T; }
    catch { throw new Error(`HeyReach returned invalid JSON: ${responseText.slice(0, 500)}`); }
  }
  async checkApiKey() { await this.request("auth/CheckApiKey"); return true; }
}
