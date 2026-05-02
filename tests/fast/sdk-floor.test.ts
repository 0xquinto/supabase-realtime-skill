// tests/fast/sdk-floor.test.ts
//
// MCP SDK floor regression gate (ADR-0016 step 3).
//
// Without this test, a future deno.json or package.json bump could drop
// `@modelcontextprotocol/sdk` below 1.27.1 (the version that landed PR #1580
// — the WebStandardStreamableHTTPServerTransport.onerror fix) and all the
// existing smokes would still pass. The smoke surface validates routing +
// E2E flow; it doesn't deliberately fault the transport, so the onerror-
// swallowing regression that the floor exists to prevent would go silently.
//
// This is the only thing standing between a package.json regex error and
// shipping a transport that silently eats errors. Mechanical, but load-bearing.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
// the SDK doesn't expose package.json via its `exports` field, so resolve
// a known sub-path (./server, used widely in src/server/) and walk up to
// the package root.
const sdkSubpath = require.resolve("@modelcontextprotocol/sdk/server");
const sdkPkgPath = resolve(dirname(sdkSubpath), "..", "..", "..", "package.json");
const sdkPkg = JSON.parse(readFileSync(sdkPkgPath, "utf8")) as {
  version: string;
};

describe("MCP SDK floor (^1.27.1)", () => {
  it("resolved version meets the ADR-0016 floor (PR #1580 onerror fix)", () => {
    const parts = sdkPkg.version.split(".").map(Number);
    const [major = 0, minor = 0, patch = 0] = parts;
    const meetsFloor =
      major > 1 || (major === 1 && minor > 27) || (major === 1 && minor === 27 && patch >= 1);
    expect(
      meetsFloor,
      `@modelcontextprotocol/sdk resolved to ${sdkPkg.version}, below the ^1.27.1 floor. Bump package.json + supabase/functions/mcp/deno.json + regen locks.`,
    ).toBe(true);
  });
});
