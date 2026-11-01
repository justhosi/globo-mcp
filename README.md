# globo-mcp

Unofficial MCP server (stdio transport) for the [GLOBO Portal](https://globohq.com/),
an interpreter-work portal. Run it with `npx globo-mcp`. No browser required.

> Slice 1 exposes a single read-only tool, `globo_whoami`. More tools arrive in later slices.

## Environment

| Variable               | Required | Description                                               |
| ---------------------- | -------- | --------------------------------------------------------- |
| `GLOBO_EMAIL`          | yes      | Portal login email                                        |
| `GLOBO_PASSWORD`       | yes\*    | Portal password (`*` not needed if session cookie is set) |
| `GLOBO_SESSION_COOKIE` | no       | Raw `_globo-portal_session` cookie value to skip login    |
| `GLOBO_BASE_URL`       | no       | Portal base URL (default `https://globohq.com`)           |
| `GLOBO_TIMEZONE`       | no       | Reserved for later slices                                 |

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
