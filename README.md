# globo-mcp

Unofficial MCP server (stdio transport) for the [GLOBO Portal](https://globohq.com/),
an interpreter-work portal. Run it with `npx globo-mcp`. No browser required.

> Exposes four read-only tools: `globo_whoami` (signed-in profile), `globo_call_summary` (call counts and minutes over a range), `globo_list_calls` (individual call rows), and `globo_monthly_minutes` (the portal's audited monthly rollup).

## Environment

| Variable               | Required | Description                                                     |
| ---------------------- | -------- | --------------------------------------------------------------- |
| `GLOBO_EMAIL`          | yes      | Portal login email                                              |
| `GLOBO_PASSWORD`       | yes\*    | Portal password (`*` not needed if session cookie is set)       |
| `GLOBO_SESSION_COOKIE` | no       | Raw `_globo-portal_session` cookie value to skip login          |
| `GLOBO_BASE_URL`       | no       | Portal base URL (default `https://globohq.com`)                 |
| `GLOBO_TIMEZONE`       | no       | Account timezone override (defaults to the profile's time zone) |

## Build / run

```sh
npm install
npm run build
npm start
```

Or without installing:

```sh
npx globo-mcp
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "globo": {
      "command": "npx",
      "args": ["globo-mcp"],
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
