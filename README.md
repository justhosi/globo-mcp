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

The published package is the easiest way to run it — no clone, no build step:

```sh
npx -y globo-mcp
```

Three ways to get the server:

1. From npm (recommended): `npx -y globo-mcp`
2. From GitHub — the latest unreleased code from master (builds from source on first run): `npx -y github:justhosi/globo-mcp`
3. From a local checkout (for development): clone and build as below, and run `node dist/index.js` — use this when editing the code.

For option 3, clone it once:

```sh
git clone https://github.com/justhosi/globo-mcp.git
cd globo-mcp
npm install
npm run build
```

Note the absolute path to `dist/index.js` — you need it only for a local checkout. Print it with:

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
GLOBO_EMAIL='you@example.com' GLOBO_PASSWORD='your-password' npx -y globo-mcp
```

From a local checkout (for development), run the built file instead:

```sh
GLOBO_EMAIL='you@example.com' GLOBO_PASSWORD='your-password' node /absolute/path/to/globo-mcp/dist/index.js
```

It prints nothing on success — it waits for JSON-RPC on stdin, and logs only to stderr.

### Credential handling

- The agent never needs your credentials. They are configuration the server reads at startup; the model only ever sees tool results, and no tool returns a credential. Never paste a password into a chat: it becomes part of the transcript and any logs, and cannot be unsent — only rotated.
- Prefer `GLOBO_SESSION_COOKIE` where you can. It is scoped to one portal session, it expires or is revoked when you sign out, and the server then never performs a password login.
- Keep literal values out of committed files. Claude Code expands `${GLOBO_PASSWORD}` inside `.mcp.json`, and OpenCode supports `{env:GLOBO_PASSWORD}`, so the secret can live in the environment. Claude Desktop does not expand variables, so its `claude_desktop_config.json` needs the literal value — and that file must never be committed.
- These credentials grant full access to the account. The portal has no scopes and no OAuth, so there is no read-only key. One account per process. If a value is ever exposed, sign out / rotate it.

## Connect a client

### Claude Code

```sh
claude mcp add globo --scope user --env GLOBO_EMAIL=you@example.com --env GLOBO_PASSWORD=your-password -- npx -y globo-mcp
```

`--scope user` makes it available in every project. To share the setup with a repository instead, commit a `.mcp.json`:

```json
{
  "mcpServers": {
    "globo": {
      "command": "npx",
      "args": ["-y", "globo-mcp"],
      "env": {
        "GLOBO_EMAIL": "${GLOBO_EMAIL}",
        "GLOBO_PASSWORD": "${GLOBO_PASSWORD}"
      }
    }
  }
}
```

Claude Code expands `${VAR}` from your environment, so a committed `.mcp.json` carries no credentials — export `GLOBO_EMAIL` and `GLOBO_PASSWORD` in your shell rather than pasting them into the file.

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
      "command": "npx",
      "args": ["-y", "globo-mcp"],
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
command = "npx"
args = ["-y", "globo-mcp"]
# From npm the first run only downloads a small package; the GitHub form also builds from source, so keep the generous timeout for that route.
startup_timeout_sec = 60
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
        "command": ["npx", "-y", "globo-mcp"],
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
opencode mcp add globo --env GLOBO_EMAIL=you@example.com --env GLOBO_PASSWORD=your-password -- npx -y globo-mcp
```

Run `opencode mcp list` to confirm it connected; inside OpenCode, `/mcps` shows the same status.

## How the data is interpreted

- **Minutes are the audited figure.** The portal reports `interpreter_minutes` for a call, and that is what it bills and pays on. When it is missing (a call not yet audited), the server falls back to the clock difference between start and end and says so per row.
- **Dates are the portal's local dates**, in your profile's timezone (see `globo_whoami`). Every analytics response echoes the zone, or `null` when the page states none — `globo_scheduled_calls` and `globo_payments` add a note explaining why.
- **Payments come from two places and are never added together.** Tipalti rows are individual payouts; the portal row set is per-method period summaries. `sources` tells you which of the two answered, and `totals.byCurrency` carries both all-status figures (`amount`, `count`) and Paid-only figures (`paidAmount`, `paidCount`), so a rejected payout is never quoted as money received.
- **Scheduled calls are the portal's table**, not a calendar feed: completed and cancelled entries stay in the list, and `upcoming_only` compares against the account timezone.
- **Long lists are paged.** The list tools return at most 1,000 rows per call (`limit`), with `offset` to walk deeper; totals always describe the whole filtered set, not the page.
- **Resources are the interpreter knowledge base.** Video articles have no prose — the media URL is returned in `media` with a note that it expires in about four hours.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Sign-in failed: wrong email or password`         | Check `GLOBO_EMAIL` / `GLOBO_PASSWORD`. No third-party login is involved.                                                                                                                                                                                                                                                         |
| `Sign-in needs multi-factor authentication (MFA)` | Your account has MFA enabled. Sign in to the portal in a browser, copy the `_globo-portal_session` cookie value and set `GLOBO_SESSION_COOKIE` instead of the password.                                                                                                                                                           |
| Tools work, then fail after a while               | Sessions expire. The server re-signs in automatically once; if the session came from `GLOBO_SESSION_COOKIE`, it cannot, and you need a fresh cookie.                                                                                                                                                                              |
| `The portal did not respond within 30s`           | The portal was slow or unreachable. Retry; raise the client's tool timeout if it happens on cold starts.                                                                                                                                                                                                                          |
| A tool reports the page layout changed            | GLOBO changed its HTML. The parsers are defensive by design, but a redesign needs a code update.                                                                                                                                                                                                                                  |
| Nothing appears in the client                     | With the npm route the first start needs network to download the package; the GitHub route also builds from source on first run, so allow up to a minute for that one. From a local checkout, check the absolute path to `dist/index.js` and that you ran `npm run build`. Servers receive no stdout chatter — logs go to stderr. |

## Privacy and security

- Credentials are read from the environment, never written to disk, and never logged. The session cookie lives in memory for the life of the process.
- The server only reads. It cannot schedule, cancel, accept or decline anything, and it cannot send messages.
- It only ever requests the portal hosts (`globohq.com`, `auth.globohq.cloud`) and Tipalti's payee dashboard (`ui2.tipalti.com`). Redirects are followed manually and clamped to those hosts, because a redirect must never carry a password or a payment token to another domain.
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

## Publishing (maintainers)

The package is published to npm as `globo-mcp`. Publishing requires 2FA. Bump the version, then publish:

```sh
npm login
npm version patch
npm publish --access public
```

`npm version patch` bumps the version and also creates a git commit and tag. The working tree must be clean before running it, and commits in this repository carry a `Reviewed-by: reviewer` trailer, so amend the bump commit (or make it by hand) to add the trailer before pushing. `npm publish` then asks for your 6-digit authenticator code; if you prefer to pass it inline, add `--otp=123456`, where `123456` is a placeholder for that code — note that inline values end up in your shell history.

Alternatively, use a granular access token with "Bypass two-factor authentication" enabled:

```sh
npm config set //registry.npmjs.org/:_authToken=YOUR_TOKEN_HERE
npm version patch
npm publish --access public
```

`YOUR_TOKEN_HERE` is a placeholder for the token value. This stores a long-lived token in plain text in `~/.npmrc`, so remove it afterwards with `npm config delete //registry.npmjs.org/:_authToken`.

The `prepare` script builds `dist/` automatically, so the tarball is always built from source rather than a stale local copy. `npm pack --dry-run` shows what would be published (63 files, including `dist/index.js`, no tests or fixtures).

## Disclaimer

Unofficial and unaffiliated with GLOBO. It signs in to _your_ account and reads _your_ data. The portal has no public API, so this drives the same private pages a browser does; a site redesign can break it. Use it at your own risk, and do not point it at an account you are not entitled to read.

## License

MIT
