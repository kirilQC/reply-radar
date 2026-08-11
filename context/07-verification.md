# 7. How to verify a change

## The constraint

**There is no local `.env`.** No `SUPABASE_URL`, no service-role key, no Anthropic key. So no local
production data, and no way to click through a feature against real rows.

This is not a temporary inconvenience to work around — it shapes how work gets delivered:

- Anything requiring live data is built as a **button in the app** that the owner clicks, not a script
  run locally. This is why the purge is a two-phase UI action.
- Correctness is proved by **running the real server against a fake Supabase** and asserting on the
  requests it emits.

## The harness pattern

Start a `node:http` server that impersonates PostgREST, boot the real Next app pointed at it, drive it
over HTTP, and assert on both the responses **and the recorded requests**.

```js
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const seen = [];
const supabase = createServer(async (req, res) => {
  const [path, query = ""] = req.url.replace("/rest/v1/", "").split("?");
  for await (const _ of req) void _;                       // drain the body
  seen.push({ path, query, prefer: req.headers.prefer || "", range: req.headers.range || "" });
  // Answer a count request the way PostgREST does: an empty page plus the total in Content-Range.
  const total = { rr_messages: 4242, rr_workspaces: 7, rr_leads: 91_500 }[path] ?? 0;
  res.writeHead(206, { "content-type": "application/json", "content-range": `0-0/${total}` }).end("[]");
});
const url = await new Promise((r) => supabase.listen(0, "127.0.0.1", () =>
  r(`http://127.0.0.1:${supabase.address().port}`)));

const app = spawn("npm", ["start", "--", "--port", "3996"], {
  cwd: "/tmp/reply-radar",
  env: { ...process.env, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "test", ANTHROPIC_API_KEY: "test", TZ: "UTC" },
  stdio: ["ignore", "pipe", "pipe"],
});
// wait for "Ready in" / "started server" on stdout or stderr, with a 40s reject
```

Then a flat list of named checks, `PASS`/`FAIL`, and `process.exit(failed ? 1 : 0)`.

### Why assert on the requests, not just the responses

A stub returns whatever you tell it to, so response assertions prove almost nothing on their own. The
requests are where the real behaviour is. For the summary route, the checks that actually matter are:

```js
["all counts come from Content-Range, not row fetches",
  requests.every((e) => e.prefer.includes("count=exact") && e.range === "0-0")],
["only inbound messages are counted",
  messageRequests.every((e) => e.query.includes("direction=eq.inbound"))],
["New York boundaries land on local midnight", …],   // 04:00 or 05:00 UTC
["Tokyo boundaries land on local midnight", …],      // 15:00 UTC the previous day
["the two zones disagree, so the zone is really being used", nyBounds !== tokyoBounds],
["yesterday is a closed range, not open-ended", requests.some((e) => e.query.includes("sent_at=lt."))],
```

That last set is the whole point: it proves the time-zone maths from the *emitted SQL filters*, which
no amount of response-shape checking would catch.

### Simulating the failure, not just the success

The most valuable harness modes are the hostile ones:

| Mode | Proves |
|---|---|
| `NO_SCORES=1` | Deletion still works when `rr_scores` does not exist (404 → 0). |
| `BLOCK_LEAD_DELETE=1` | A silently-ignored delete produces `502`, not `200`. Output: `502 {"ok":false,"error":"Delete did not finish: 2 lead row(s) and 0 conversation(s) are still present."}` |
| A deliberately invalid `timeZone` | The home page falls back to UTC instead of 500ing. |
| A duplicated outbound greeting | The purge classifies from the deduped thread, so it doesn't read as the lead having opened the conversation. |

If a fix is about *not* failing silently, the harness has to make it fail.

## Harnesses written so far

Kept in `/tmp/rr-harness/`, deliberately **not committed** — they hardcode ports and an absolute
`cwd`, and they exist to prove a specific change rather than to guard the repo. Recreate from the
pattern above as needed.

| File | Port | Checks | Covers |
|---|---|---|---|
| `delete-purge.mjs` | 3997 | 24 | Full in-memory PostgREST emulator: `eq.`, `in.()`, `order`, `limit`, `offset`, `DELETE` with `return=representation`, 404 for absent tables. Runs in `NO_SCORES` and `BLOCK_LEAD_DELETE` modes. |
| `summary-stats.mjs` | 3996 | 17 | Home-page counts and time-zone boundaries; lead-heading totals. |
| `scoring-defaults.mjs` | 3998 | 9 | Vetted defaults apply to unconfigured clients. |
| `templates-api.mjs` | 3999 | 6 × 2 | Shared prompt library, in two storage modes. |
| `patch-fetch.mjs` | — | — | Intercepts `api.anthropic.com` **inside** the Next server via `NODE_OPTIONS=--import`. This is how AI routes are tested without a key. |
| `ai-sweep.mjs` | — | — | The worker's sweep against a fake app. |

## Practical notes

- **Kill the port first, every time.** `SIGKILL` on `npm start` can leave the child listening:
  ```bash
  lsof -ti tcp:3996 | xargs -r kill -9
  ```
- Set `TZ=UTC` in the app's env so time-zone assertions are about the *requested* zone rather than the
  machine's.
- Use `npm start` (a real production build) rather than `npm run dev`, so you're testing what ships.
- Drain the request body in the stub (`for await (const _ of req) void _`) or `DELETE`/`POST` requests
  will hang.

## The committed test suite

`npm test` → `node --test tests/*.test.mjs`, **10 tests**, all passing. Pure unit tests over
`app/lib/*` with no server and no network:

- `tests/ai-ark-enrichment.test.mjs` — enrichment extraction, exact-vs-partial company matching,
  picking the right LinkedIn person rather than the first search result, attribution and rollup.
- `tests/heyreach-conversation.test.mjs` — webhook validation payload detection, message
  normalisation, the merge contract, chronological ordering.

Node strips the TypeScript from the imported `app/lib/*.ts` natively; no build step.

## Before every commit

```bash
npm run typecheck     # must be clean
npm run lint          # exactly 6 errors — see 05-conventions-and-gotchas.md
npm test              # 10 passing
npm run build         # check the new route appears in the route list
```

Then confirm the route list actually contains what you added, e.g. `ƒ /api/analytics/summary`.
