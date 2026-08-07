declare module "cloudflare:workers" {
  /**
   * Kept as a small compatibility shim for the optional D1 example that ships
   * with the starter. Reply Radar uses Supabase in production, so this binding
   * is not loaded by the Next.js application.
   */
  export const env: { DB?: unknown };
}
