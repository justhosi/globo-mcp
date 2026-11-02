import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { USER_AGENT, VERSION } from "../src/version.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as unknown as { version: string };

describe("version", () => {
  it("tracks the package version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("derives the User-Agent from the package version", () => {
    expect(USER_AGENT).toBe(`globo-mcp/${pkg.version}`);
    expect(USER_AGENT).toMatch(/^globo-mcp\/\d+\.\d+\.\d+/);
  });
});
