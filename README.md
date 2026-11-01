# globo-mcp

Unofficial MCP server (stdio transport) for the [GLOBO Portal](https://globohq.com/),
an interpreter-work portal. No browser required.

> Exposes six read-only tools: `globo_whoami` (signed-in profile), `globo_call_summary` (call counts and minutes over a range), `globo_list_calls` (individual call rows), `globo_monthly_minutes` (the portal's audited monthly rollup), `globo_scheduled_calls` (scheduled appointments from your per-user schedule), and `globo_assignments` (the interpreter's assignment history).
>
> Privacy note: `globo_scheduled_calls` reads only the signed-in user's own table on `/scheduled_calls`. It never calls `/scheduled_calls/get_data` — that endpoint is not user-scoped and returns the whole platform's schedule (other people's names, phone numbers, and appointments).

## Status

Early work-in-progress. **6 of 9 planned tools** are shipped; the remaining
three are `globo_payments` (payout history) and `globo_resources` /
`globo_resource` (portal documentation). The six shipped tools include
`globo_assignments`, which reads the interpreter's assignment history — a
record separate from ordinary calls that may carry an informational note — and
are stable and covered by fixture-driven tests.

## Disclaimer

This project is **unofficial and not affiliated with GLOBO**. It signs in to
_your own_ account and reads only _your own_ data. GLOBO exposes no public API,
so the server reads the portal's private pages and JSON responses; when the
portal changes its markup, parsing can break until this project catches up.
Use it at your own risk and respect GLOBO's terms of service.

## Environment

| Variable               | Required | Description                                                     |
| ---------------------- | -------- | --------------------------------------------------------------- |
| `GLOBO_EMAIL`          | yes      | Portal login email                                              |
| `GLOBO_PASSWORD`       | yes\*    | Portal password (`*` not needed if session cookie is set)       |
| `GLOBO_SESSION_COOKIE` | no       | Raw `_globo-portal_session` cookie value to skip login          |
| `GLOBO_BASE_URL`       | no       | Portal base URL (default `https://globohq.com`)                 |
| `GLOBO_TIMEZONE`       | no       | Account timezone override (defaults to the profile's time zone) |

## Install

The package is **not published to npm yet**, so `npx globo-mcp` will 404 for
now. Install from source:

```sh
git clone https://github.com/justhosi/globo-mcp.git
cd globo-mcp
npm install
npm run build
```

Then point your MCP client at the built entry point, using an absolute path:

```sh
node /absolute/path/to/globo-mcp/dist/index.js
```

Once the package is published to npm, the following will work instead:

```sh
npx globo-mcp
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "globo": {
      "command": "node",
      "args": ["/absolute/path/to/globo-mcp/dist/index.js"],
      "env": {
        "GLOBO_EMAIL": "you@example.com",
        "GLOBO_PASSWORD": "…"
      }
    }
  }
}
```

## License

MIT — see [LICENSE](LICENSE).
