export {}

declare global {
    /**
     * Environment variables available in server-side code (.server.ts, .webhook.ts and
     * .event.ts files and their imports). Values come from the app's .env and .env.local
     * files in development and from the app's environment variables in production.
     * Reading a variable that is not set returns `undefined` and logs a warning.
     *
     * WARNING: `process` only exists in the server runtime. Global declarations cannot be
     * scoped to server files, so client-side code also type-checks — but accessing
     * `process` there throws a ReferenceError at runtime.
     */
    var process: {
        readonly env: Record<string, string | undefined>
    }
}
