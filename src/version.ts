import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as unknown as { version: string };

/** Package version from `package.json` (single source of truth). */
export const VERSION: string = pkg.version;
/** `User-Agent` header value sent on portal and Tipalti requests. */
export const USER_AGENT = `globo-mcp/${VERSION}`;
