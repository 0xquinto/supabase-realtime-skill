# vendor/foundation/

Snapshot of `src/foundation/` from [supabase-mcp-evals](https://github.com/0xquinto/supabase-mcp-evals) at commit `fceeec7` (2026-04-30). Apache-2.0.

These small utility modules are *vendored* (copied) rather than published as a package or pulled via submodule because the upstream repo is a research/methodology workspace, not a library. Vendoring keeps the artifact self-contained and the attribution clear.

Files:
- `api-client.ts` — Supabase Management API client w/ exponential backoff retries
- `branch.ts` — `withBranch` async-disposable branch lifecycle
- `scoring.ts` — Wilson score interval, paired aggregation
- `transcript.ts` — agent transcript parsing for tool-call analysis

If upstream changes meaningfully, update the snapshot and bump the SHA above. Don't edit these files in-place — fork via a wrapper if behavior needs to differ.
