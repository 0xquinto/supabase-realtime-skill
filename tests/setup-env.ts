// tests/setup-env.ts
//
// Vitest runs under node, but `bun run` does not propagate .env contents to
// node subprocesses (Bun loads .env into its own process; child node sees
// only inherited shell env). The fast-test suite doesn't care, but smoke
// tests need EVAL_SUPABASE_PAT / EVAL_HOST_PROJECT_REF.
//
// Tiny manual loader (no dependency) — vitest setupFiles runs once per file
// before tests, populating process.env. Idempotent + tolerant of a missing
// .env (the smoke describe.skipIf still kicks in).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
