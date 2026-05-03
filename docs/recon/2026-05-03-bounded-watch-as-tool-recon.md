# Recon: bounded-watch as a deterministic agent tool — design forks before ADR-0017 (2026-05-03)

Pre-ADR recon for elevating the current `boundedWatch` primitive from "demo-shape" to a **deterministic agent tool** with persistent cursor + typed action contract + measured isolate-budget bench. Filed on branch `recon/bounded-watch-as-tool`. Mirrors the decisions-and-receipts shape of [`2026-05-02-edge-function-tool-routing-recon.md`](2026-05-02-edge-function-tool-routing-recon.md).

> **What does the cursor / contract / runtime model look like, and is the framing "bounded subscription as the streaming-equivalent of context-window budgeting for tool calls" novel enough to coin?**

The user-facing case for doing this work was settled in conversation: the demo without a real engineering ship is theatre; recon's job is to keep the engineering ship from drifting on already-solved problems. Five decision-forks isolate the actual design choices.

## Why this recon, why now

The conversation route from "v0.3.0 shipped" → "what's next" surfaced three internal-narrative paths (manifest n=300, T31 upstream issue, engagement-vehicle recon) and one cooked-shape path (real engineering ship + post + demo). The cooked path has a real architectural surface and ten years of CDC-consumer prior art we'd be foolish to reinvent. This recon resolves the surface before the cursor code starts.

## Internal recon

The current `boundedWatch` primitive (`src/server/realtime-client.ts` + `src/server/server.ts`) handles substrate gotchas correctly (RLS payload stripping, warm-up window, private-channel auth, single-client dedup, GRANT chain) but has **no persistent state**. An isolate restart loses queue state and re-processes events that already side-effected. Action callback is hardcoded per tool. Multi-watcher behavior in a single isolate has no measured budget.

The deterministic-tool delta is three concrete layers:
1. **Persistent cursor** — DB-backed `(watcher_id, last_processed_pk, last_processed_at, lease_holder, heartbeat_at)` so restarts resume from N+1, not 0.
2. **Typed action contract** — `(event) => Promise<Result>` with retry/dedup/observability built into the wrapper, not the user's callback.
3. **Multi-watcher isolate-budget bench** — measured p95/p99 + heap peak at N watchers in one Edge isolate, so the "bounded primitive" framing has numbers backing it.

Of these, the cursor is the load-bearing engineering ship — the rest follow once the state machine is named.

## External recon — five decision-forks

### Fork 1: cursor vocabulary + delivery semantics

**Adopt at-least-once + idempotency-key dedup (the Debezium model).**

Sources:
- [RisingWave 2026-04-02 "CDC Exactly-Once Semantics: Debezium vs RisingWave"](https://risingwave.com/blog/cdc-exactly-once-semantics-debezium-risingwave/) — Debezium provides at-least-once into Kafka; effectively-once requires idempotent producers + transactions across every layer; **end-to-end exactly-once is the hardest problem in CDC and we should not attempt it.**
- [RisingWave issue #25071](https://github.com/risingwavelabs/risingwave/issues/25071) (2026-03-13) — concrete failure mode: Debezium periodic offset flush advancing Postgres replication slot `restart_lsn` *without* a consumer-side checkpoint causes unrecoverable WAL gap on pod restart. **Lesson:** cursor-advance must be coupled to action-success commit, never time-based or speculative.
- [Vahid Negahdari, "Hidden Complexity of PG Logical Replication"](https://medium.com/%40vahidne/the-hidden-complexity-of-postgresql-logical-replication-35441a292de9) (2026-01-12) — vocabulary: `replication slot`, `restart_lsn`, `confirmed_flush_lsn`, `feedback message`. Treating WAL positions as offsets leads to replays or gaps.

**Decision:** cursor model = `{watcher_id, last_processed_pk, last_processed_at, idempotency_key, lease_holder, heartbeat_at, status: idle|leased|processing|committed|dlq}`. Action invocation is at-least-once; user's action is responsible for being idempotent under the same `idempotency_key`. Cursor advances *only* on action success commit. State machine and vocab adopt Debezium's "offset-after-commit" pattern, not Postgres's WAL-LSN coupling (we sit a layer above logical replication — Realtime is our wire protocol).

**Vocabulary mapping (callback ↔ cursor row):** the user's `dedupKey: (row) => string` callback in the SDK contract (Fork 4 prescription / § Direction signature) computes the `idempotency_key` value stored on the cursor row. Cursor row is the persistence side; callback is the user-facing input side; same logical key, two surfaces.

### Fork 2: Edge runtime stateful vs stateless

**Stay stateless + DB-backed cursor. Document Cloudflare Durable Objects as the alternative for users who want stateful actors.**

Sources:
- [reptile.haus, "Durable Execution: Missing Layer in AI Agent Stack"](https://reptile.haus/journal/durable-execution-ai-agents-temporal-restate-inngest-2026/) (2026-04-16) — durable execution is the 2026 framing; AWS Durable Functions, Cloudflare Workflows, Vercel Workflow DevKit all shipped late 2025; Gartner predicts 40% enterprise apps with AI agents by year-end.
- [pkgpulse, "Cloudflare DO vs Upstash vs Turso 2026"](https://www.pkgpulse.com/blog/cloudflare-durable-objects-vs-upstash-vs-turso-edge-2026) — DOs are single-instance always-warm actors with attached SQLite; canonical edge-stateful primitive.
- [Hookdeck, "Webhook Gateway vs Durable Runtime"](https://hookdeck.com/webhooks/platforms/webhook-gateway-vs-durable-runtime-agent-workflows) (2026-04-20) — distinct layers: ingress reliability (gateway) vs execution reliability (runtime). Our wrapper is neither — it's substrate-correct *ingestion-into-an-MCP-tool*. Different layer.

**Decision:** stateless+cursor for the Supabase-Edge-resident path. Document explicitly that Cloudflare Durable Objects are the right alternative if the user's stack is CF-shaped — we don't compete on that surface, we differentiate on Supabase-coupling + MCP-native + bounded-substrate-correctness.

### Fork 3: MCP `notifications/*` and `resources/subscribe`

**Phase 1: keep bespoke tools (`watch_table`, `subscribe_to_channel`). Phase 2: add an MCP-native `resources/subscribe` path so both work.**

Sources:
- [MCP spec 2025-11-25 § resources](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/server/resources.mdx) — `resources/subscribe` request → `notifications/resources/updated` notification → `resources/unsubscribe`. The notification carries the changed resource's URI but **does not carry the changed payload**; the agent re-reads via `resources/read`.
- [MCP architecture docs](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/docs/learn/architecture.mdx) — notifications are JSON-RPC 2.0 fire-and-forget; servers can also notify on `tools/list_changed` and `prompts/list_changed`.

**Tension:** the MCP-native pattern is pull-mode (notify-then-reread). Bounded-watch needs payload-with-event for latency-bounded reactivity (∼100-200ms post-warmup, per spike). If we fold into `resources/subscribe`, the agent pays an extra round-trip per event.

**Decision:** Phase 1 keeps the current bespoke-tool surface (it's already shipped and works). Phase 2 (post-cursor ship) adds an `resources/subscribe`-shaped alternate path where each `support_tickets/{pk}` row is exposed as an MCP resource, the bounded subscription is re-shaped into a resource-list subscription, and the notification fires on each row commit. Users who want MCP-native pick that path; users who want push-payload-with-event keep the tool path. Document the tradeoff explicitly in the writeup. **This is a real Phase 2 ADR (numbering TBD when filed) — out of ADR-0017's scope, but recon-flagged here so we don't rebuild Phase 2 from scratch.**

### Fork 4: novel-framing check ("bounded subscription as context-window for streams")

**Framing-room appears open in a focused 2026-05-03 scan; the primitive earns the framing if shipped, not the other way around.**

Sources scanning for prior art (Exa scan, ~10 results, 2024-06 → 2026-05):
- [luaxe.dev, "The Context Window Is the Process Boundary"](http://www.luaxe.dev/blog/2026-03-17-the-context-window-is-the-process-boundary/) (2026-03-17) — argues context window IS the process boundary for coding agents; no extension to streams.
- [Zylos, "Rate Limiting and Backpressure for AI Agent APIs"](https://zylos.ai/research/2026-02-25-rate-limiting-backpressure-ai-agent-apis) (2026-02-25) — closest adjacent framing; argues RPS rate limiting fails for agents because cost is heterogeneous; doesn't extend to streaming subscriptions specifically.
- [learnwithparam, "Context Window Management for Production Agents"](https://www.learnwithparam.com/blog/context-window-management-production-ai-agents) (2026-02-27) — tactical compression patterns; not a streaming primitive.
- [Antigravity Lab, "Context Compression Sub-Agent in AgentKit 2.0"](https://antigravitylab.net/en/articles/agents/antigravity-agentkit2-context-compression-subagent-design) (2026-04-27) — sub-agent compression pattern; orthogonal.
- [pydantic-ai-harness #146](https://github.com/pydantic/pydantic-ai-harness/issues/146) (2026-04-02) — sub-agent event propagation through parent stream; framework-internal, not a substrate primitive.
- [Mastra PR #15686](https://github.com/mastra-ai/mastra/pull/15686) (2026-04-23) — `streamUntilIdle` keeps streams open until background tasks complete; orthogonal.

**Verdict:** a focused Exa scan didn't surface the explicit framing "bounded subscription is to streaming what context-window-budgeting is to tool-calls" (this is scan-shape evidence, not exhaustive — claims open framing-room, not provable absence). The adjacent work (rate-limiting, context-window management, durable execution) is real and well-developed but operates at different abstraction layers. **The primitive earns the framing if shipped; framing without primitive is process-as-moat shaped.**

**Discipline-check (per CLAUDE.md § Anti-patterns "process-as-moat"):** "we coined a framing" is not the value — the bounded primitive + measured isolate budget + substrate-correct wrapper is the value. The framing is a description of the value, not the value itself. If we frame the post around the framing rather than the primitive, that's drift. Headline is the primitive; framing is one paragraph in.

### Fork 5: competitor + ecosystem scan

**Closest competitors operate at different abstraction layers; differentiation is real.**

Sources:
- [Inngest + Neon](https://inngest.com/docs/features/events-triggers/neon) and [Inngest + Prisma Pulse](https://inngest.com/docs/features/events-triggers/prisma-pulse) — "trigger Inngest functions from Postgres CDC events." Closest functional overlap. **Different layer:** managed durable runtime, requires their cloud, not MCP-native, agent code lives in their serverless functions.
- [Trigger.dev Realtime](https://trigger.dev/launchweek/2/realtime) (2025-08, GA) — real-time updates *from* tasks *to* the frontend (showing run progress), not the other direction. Different use case.
- [Hookdeck Webhook Gateway](https://hookdeck.com/webhooks/platforms/webhook-gateway-vs-durable-runtime-agent-workflows) — webhook-shaped ingestion, not subscription-shaped.
- [Supabase BYO-MCP guide](https://supabase.com/docs/guides/getting-started/byo-mcp) (2026-04-30) — Supabase's own "deploy MCP server on Edge Functions" guide, references MCP spec 2025-11-25 and uses `WebStandardStreamableHTTPServerTransport` (the same transport we use). **Critically: the page does NOT mention Postgres-Changes / Realtime / CDC as MCP tools or resources.** Our space is open within the Supabase ecosystem itself.
- [Supabase MCP](https://supabase.com/mcp) (remote MCP install guide, 2026-05-01) — covers the official Supabase remote-MCP product (database queries, project management); not a CDC primitive.

**Decision:** position the artifact as `MCP-native + Edge-resident + Supabase-coupled + bounded-substrate-correct` against `Inngest = managed-durable-runtime + cloud-coupled` and `Cloudflare DO = stateful-actor + CF-coupled`. These are complementary, not competitive — a user could run Inngest *triggered by* our wrapper if they want both layers. Differentiation is real.

## Direction: ADR-0017 commitments

The counter-recon (sibling file) cleared with one architectural carve-out (R4 → Phase 2 deferral). ADR-0017 commits:
1. **Cursor design** — the state machine + vocabulary from Fork 1. Predicted effect: restart smoke test passes (write test scaffold first, FAIL→fix→PASS shape per ADR-0011 / 0013 pattern).
2. **Typed action contract** — single `boundedWatch<TRow, TResult>(...)` SDK signature with `dedupKey`, `action`, `onError`, `observe` hooks. Two built-in actions (`httpAction`, `claudeAction`).
3. **Multi-watcher isolate-budget bench** — measured p95/p99 + heap peak at N=1, 5, 10, 20 watchers in one Edge isolate. Numbers ship with the post.
4. **Failure-model packaged** — every documented gotcha (RLS payload stripping, warm-up, private-channel ack, single-client dedup, GRANT chain, `httpSend` reject contract) gets a regression test in `tests/fast/` or `tests/smoke/`.
5. **Phase 2 deferred** — `resources/subscribe`-shaped alternate path is the next ADR after 0017 (numbering TBD when filed), not ADR-0017's scope. Recon has flagged it so the SDK surface doesn't preclude it.

## Out of scope (and why)

- **Multi-tenant fan-out** — already deferred per ADR-0014; v2-hardening surface, not Phase-1.
- **Manifest n=300** — orthogonal to this work; the framing-drift filter (process-as-moat) caught the impulse to bundle it.
- **T31 upstream issue file** — engagement-vehicle data point: 2 recent `[User Feedback]` issues (#63, #70) sit at 0 engagement after 10-23 days. Suggestive, not conclusive (n=2). Ordering decision: cooked-shape post + demo first; T31 reconsidered after the post lands (post + repo link makes any subsequent issue file land warmer than a cold ask).
- **MCP authentication** — Supabase's own BYO-MCP guide flags "auth support coming soon"; we ride that timeline.

## Pre-counter-recon tilt

**Direction:** ship ADR-0017 with the three engineering layers (cursor + contract + bench) and the failure-model package; write the post with the primitive (not the framing) as headline; defer Phase 2 (`resources/subscribe`) to ADR-0018.

The counter-recon (sibling file) steelman the strongest "this whole direction is wrong" reads before any code commits.
