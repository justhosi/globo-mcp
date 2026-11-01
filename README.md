# globo-mcp

An unofficial MCP server for the [GLOBO](https://globohq.com/) interpreter portal. It signs in with your own GLOBO account and lets an AI assistant read your call statistics, schedule, assignments, payouts and the interpreter knowledge base.

No browser, no scraping service, no account sharing: it speaks the portal's own login flow over plain HTTPS and keeps the session in memory.

## What it can answer

| Tool                    | Question it answers                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `globo_whoami`          | Who am I on the portal — name, interpreter ID, timezone, payment method, last sign-in.                                             |
| `globo_call_summary`    | How many telephone and video calls did I take, and how many minutes, in any date range — optionally grouped by day, week or month. |
| `globo_list_calls`      | Which calls were those — date, start, end, company, service, minutes; filterable by company, service and minimum length.           |
| `globo_monthly_minutes` | What does the portal itself report per month (for cross-checking my own totals).                                                   |
| `globo_scheduled_calls` | What is on my schedule — project number, type, company, language, date, time, status, duration.                                    |
| `globo_assignments`     | What assignments have I worked, with the "Additional Information" note the portal attached.                                        |
| `globo_payments`        | How much was I paid and when — from both the Tipalti payout history and the portal's own payments table.                           |
| `globo_resources`       | What categories are in the interpreter knowledge base, or which articles a category holds.                                         |
| `globo_resource`        | The full text of one knowledge-base article, with its links and media.                                                             |

It also exposes MCP resources, so a client can browse instead of calling tools:

- `globo://profile` — your profile
- `globo://resources` — the knowledge-base index
- `globo://resource/<slug>` — one article

Example requests once connected:

- "How many telephone calls and minutes did I interpret in September 2026?"
- "Compare my video minutes month by month this year."
- "Show my ten longest calls last quarter."
- "What is on my schedule for the next two weeks?"
- "When was my last assignment, and did it carry a shift-program note?"
- "How much was I paid in 2026, and was anything rejected?"
- "Find the GLOBO article about HIPAA and summarise it."

## Requirements

- Node.js 20.3 or newer
- A GLOBO interpreter account
- Nothing else — no API key, no browser, no Playwright

## Install

The package is not published to npm yet, so run it from source. Clone it once:

```sh
git clone https://github.com/justhosi/globo-mcp.git
cd globo-mcp
npm install
npm run build
```

Note the absolute path to `dist/index.js` — every client below needs it. Print it with:

```sh
node -e "console.log(require('path').resolve('dist/index.js'))"
```

## Credentials

The server reads these environment variables:

| Variable               | Required | Meaning                                                                                       |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `GLOBO_EMAIL`          | yes      | Your portal email                                                                             |
| `GLOBO_PASSWORD`       | yes*     | Your portal password                                                                          |
| `GLOBO_SESSION_COOKIE` | no       | An existing `_globo-portal_session` value, if you prefer not to give the server your password |
| `GLOBO_TIMEZONE`       | no       | IANA zone override, e.g. `Europe/Istanbul`; defaults to your profile's zone                   |
| `GLOBO_BASE_URL`       | no       | Only for testing against another host; must be HTTPS                                          |

\* unless `GLOBO_SESSION_COOKIE` is set.

Start the server by hand to check it works:

```sh
GLOBO_EMAIL='you@example.com' GLOBO_PASSWORD='your-password' node /absolute/path/to/globo-mcp/dist/index.js
```

It prints nothing on success — it waits for JSON-RPC on stdin, and logs only to stderr.

## Connect a client

### Claude Code

```sh
claude mcp add globo \
  --env GLOBO_EMAIL=you@example.com \
  --env GLOBO_PASSWORD=your-password \
  -- node /absolute/path/to/globo-mcp/dist/index.js
```

Add `--scope user` to make it available in every project. To share the setup with a repository instead, commit a `.mcp.json`:

```json
{
  "mcpServers": {
    "globo": {
      "command": "node",
      "args": ["/absolute/path/to/globo-mcp/dist/index.js"],
      "env": {
        "GLOBO_EMAIL": "you@example.com",
        "GLOBO_PASSWORD": "your-password"
      }
    }
  }
}
```

Check it with `/mcp` inside Claude Code.

### Claude Desktop

Edit the config file, then restart the app:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`
- Linux — `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "globo": {
      "command": "node",
      "args": ["/absolute/path/to/globo-mcp/dist/index.js"],
      "env": {
        "GLOBO_EMAIL": "you@example.com",
        "GLOBO_PASSWORD": "your-password"
      }
    }
  }
}
```

### Codex

Add a block to `~/.codex/config.toml` (or `.codex/config.toml` inside a trusted project):

```toml
[mcp_servers.globo]
command = "node"
args = ["/absolute/path/to/globo-mcp/dist/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 120

[mcp_servers.globo.env]
GLOBO_EMAIL = "you@example.com"
GLOBO_PASSWORD = "your-password"
```

The longer timeouts matter: a cold run signs in, then loads a few portal pages, and can take up to about ten seconds. `codex mcp list` shows whether the server started.

### OpenCode

Add the server to `opencode.jsonc` (project) or `~/.config/opencode/opencode.jsonc` (global):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "globo": {
        "type": "local",
        "command": ["node", "/absolute/path/to/globo-mcp/dist/index.js"],
        "environment": {
          "GLOBO_EMAIL": "{env:GLOBO_EMAIL}",
          "GLOBO_PASSWORD": "{env:GLOBO_PASSWORD}",
        },
      },
    },
  },
}
```

`{env:NAME}` reads the value from your shell environment, so the password never has to sit in the config file. Or add it from the CLI:

```sh
opencode mcp add globo --env GLOBO_EMAIL=you@example.com --env GLOBO_PASSWORD=your-password -- node /absolute/path/to/globo-mcp/dist/index.js
```

Run `opencode mcp list` to confirm it connected; inside OpenCode, `/mcps` shows the same status.

## How the data is interpreted

- **Minutes are the audited figure.** The portal reports `interpreter_minutes` for a call, and that is what it bills and pays on. When it is missing (a call not yet audited), the server falls back to the clock difference between start and end and says so per row.
- **Dates are the portal's local dates**, in your profile's timezone (see `globo_whoami`). Every response echoes the zone, or `null` with a note when the page itself states none.
- **Payments come from two places and are never added together.** Tipalti rows are individual payouts; the portal row set is per-method period summaries. `sources` tells you which of the two answered, and `totals.byCurrency` carries both all-status figures (`amount`, `count`) and Paid-only figures (`paidAmount`, `paidCount`), so a rejected payout is never quoted as money received.
- **Scheduled calls are the portal's table**, not a calendar feed: completed and cancelled entries stay in the list, and `upcoming_only` compares against the account timezone.
- **Resources are the interpreter knowledge base.** Video articles have no prose — the media URL is returned in `media` with a note that it expires in about four hours.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sign-in failed: wrong email or password`         | Check `GLOBO_EMAIL` / `GLOBO_PASSWORD`. No third-party login is involved.                                                                                               |
| `Sign-in needs multi-factor authentication (MFA)` | Your account has MFA enabled. Sign in to the portal in a browser, copy the `_globo-portal_session` cookie value and set `GLOBO_SESSION_COOKIE` instead of the password. |
| Tools work, then fail after a while               | Sessions expire. The server re-signs in automatically once; if the session came from `GLOBO_SESSION_COOKIE`, it cannot, and you need a fresh cookie.                    |
| `The portal did not respond within 30s`           | The portal was slow or unreachable. Retry; raise the client's tool timeout if it happens on cold starts.                                                                |
| A tool reports the page layout changed            | GLOBO changed its HTML. The parsers are defensive by design, but a redesign needs a code update.                                                                        |
| Nothing appears in the client                     | Check the absolute path to `dist/index.js`, and that you ran `npm run build`. Servers receive no stdout chatter — logs go to stderr.                                    |

## Privacy and security

- Credentials are read from the environment, never written to disk, and never logged. The session cookie lives in memory for the life of the process.
- The server only reads. It cannot schedule, cancel, accept or decline anything, and it cannot send messages.
- It only ever requests the portal hosts (`globohq.com`, `auth.globohq.cloud`) and Tipalti's payment endpoint. Redirects are followed manually and clamped to those hosts, because a redirect must never carry a password or a payment token to another domain.
- It reads only the signed-in account's own pages. The portal has a platform-wide endpoint that would return other interpreters' names and phone numbers (`/scheduled_calls/get_data`); this project never calls it, deliberately.
- Payment detail links are recorded, never fetched.
- No telemetry, no analytics, no external service.

## Development

```sh
npm test           # unit tests, offline, stubbed transport
npm run build      # tsc to dist/
npm run lint
npm run typecheck  # includes the tests
npx prettier --check .
```

Tests never touch the network: every parser runs against recorded fixtures, and the HTTP client is stubbed. The portal is HTML-scraped, so the fixtures are the regression guard — when a page changes, capture it and add a fixture.

Layout:

```
src/index.ts        MCP server: tools, resources, error mapping
src/auth.ts         Auth0 login over plain HTTP, single-flight
src/http.ts         cookie jar, redirect clamping, timeouts
src/config.ts       environment parsing
src/portal/         one module per data area
```

## Disclaimer

Unofficial and unaffiliated with GLOBO. It signs in to _your_ account and reads _your_ data. The portal has no public API, so this drives the same private pages a browser does; a site redesign can break it. Use it at your own risk, and do not point it at an account you are not entitled to read.

## License

MIT
