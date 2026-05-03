# Counter-recon: bounded-watch as a deterministic agent tool — adversarial pass (2026-05-03)

Adversarial sibling to [`2026-05-03-bounded-watch-as-tool-recon.md`](2026-05-03-bounded-watch-as-tool-recon.md). Per CLAUDE.md memory feedback "adversarial pass on every recon / ADR" — the first risk is direction, not execution. Five strongest "this whole direction is wrong" reads, steelmanned and resolved.

## R1: "You're inventing a category that doesn't exist for a reason."

**Steelman:** Every product that's solved adjacent problems sits at a different abstraction layer — Inngest at managed-durable-runtime, Cloudflare DO at stateful-actor, Hookdeck at webhook-gateway. There's a reason no one has shipped "bounded subscription primitive on Edge for MCP-native agents" — the surface is too narrow, the audience is too thin, and engineers building agents pick a runtime, not a primitive. Coining a category to occupy it alone is the strongest tell of process-as-moat.

**Counter-evidence:**
- Supabase's own BYO-MCP guide (2026-04-30, [supabase.com/docs/guides/getting-started/byo-mcp](https://supabase.com/docs/guides/getting-started/byo-mcp)) is exactly this surface: "deploy MCP servers on Edge Functions." They've staked out the MCP-on-Edge slot. Our wrapper extends it to Realtime/CDC, which their guide does not cover.
- The substrate gotchas (RLS payload stripping, GRANT chain, JWT propagation, warm-up, single-client dedup) don't disappear by switching to Inngest or DO — those products solve a layer above. A user running Inngest triggered by Supabase webhooks still hits the same gotchas if they wire up Realtime themselves.
- The space is narrow but real: anyone building a Claude/Cursor/Cline-shaped agent on Supabase has this exact stack. It's not a category invention; it's a primitive for an existing combination.

**Resolved as:** R1 doesn't collapse our direction, but it correctly identifies that the *framing* (not the primitive) is where category-invention drift can creep in. Ship the primitive; let the framing earn itself by doing.

## R2: "Inngest + Prisma Pulse already solves this."

**Steelman:** Inngest's `db/user.created` events triggered by Prisma Pulse already deliver "agent reacts to Postgres CDC." Our wrapper is one more thing for engineers to learn, with a smaller team behind it, no managed cloud, no failure recovery UI. A senior engineer will pick the managed product 9 times out of 10.

**Counter-evidence:**
- Inngest requires their cloud. Vendor-locked, billable, separate deployment surface from Supabase. **The Supabase-native, Edge-resident, no-additional-runtime story is the differentiator.**
- Prisma Pulse requires Prisma ORM + their hosted change-streaming infra. Adds two products to the stack.
- MCP-native: Inngest functions are not MCP tools. An agent calling Inngest goes through HTTP/SDK, not through MCP. For agents that *are* the system (vs. agents that call into a system), the primitive needs to be MCP-shaped.
- Cost model: Inngest charges per step + retention; our wrapper is a bundle deployed on the user's own Edge Function (zero additional cost for a Supabase Pro user already paying for the project).

**Resolved as:** R2 is a real overlap and we should acknowledge it explicitly in the writeup. Position as **complementary, not competitive**: a user can run Inngest *consuming* our wrapper's events if they want durable execution + bounded ingestion. Don't pretend Inngest doesn't exist.

## R3: "Cloudflare Durable Objects make 'bounded' irrelevant."

**Steelman:** A DO is single-writer, always-warm, has SQLite-attached durable state. Why deploy a stateless Edge Function with a Postgres-backed cursor when each watcher could be a DO with native state? The DO model is strictly better: no cursor table, no lease/heartbeat machinery, no restart smoke test — the runtime guarantees the actor lives.

**Counter-evidence:**
- Cloudflare-coupling. The artifact's mandate is Supabase-native deployment surface. A user choosing Supabase Edge over CF Workers has already selected against DO.
- Substrate-correctness gotchas (RLS, GRANT, JWT propagation) are agnostic to runtime — they live in the Postgres + Realtime + supabase-js stack, not in the runtime that hosts the subscription. DOs don't make those gotchas go away.
- Per-watcher cost model: DOs are billed per-instance + per-message. The bounded-watch story is "N watchers in one isolate." Different cost shape.
- We should document DO explicitly as the right choice for users on Cloudflare. Not all roads need to converge on Supabase.

**Resolved as:** real architectural alternative for a different deployment surface. Document it; don't pretend it doesn't exist; differentiate on Supabase-coupling rather than competing on stateful-actor semantics.

## R4: "MCP `resources/subscribe` is the right surface and bespoke tools are vestigial."

**Steelman:** MCP spec 2025-11-25 has `resources/subscribe` + `notifications/resources/updated`. The agent ecosystem is converging on this primitive. Our `watch_table` and `subscribe_to_channel` tools are pre-spec inventions that may need migration anyway. We should skip Phase 1 (cursor on bespoke tools) and ship Phase 2 (resource-subscribe-shaped path) directly. Phase 1 is throwaway work.

**Counter-evidence:**
- `notifications/resources/updated` is **pull-mode**: notification carries the URI but not the changed payload; agent re-reads via `resources/read`. For latency-sensitive bounded-watch (∼100-200ms post-warmup), a round-trip-per-event is wrong. Push-payload-with-event needs the bespoke-tool shape.
- Phase 1 (cursor + contract on the bespoke surface) is NOT throwaway: the cursor + state machine + idempotency + retry policy + multi-watcher bench are all reusable in Phase 2's resource-subscribe path. The state-handling layer is independent of the wire-protocol layer.
- The bespoke-tool surface is shipped, deployed, smoke-tested. Migrating it to `resources/subscribe`-only would be a regression-risk move when the cursor + contract work is the critical-path engineering ship.

**Resolved as:** R4 is the most architecturally interesting risk and the recon already flags it as a real Phase 2 concern (ADR-0018). Phase 1 stays bespoke; Phase 2 adds the resource-subscribe alternate path; both coexist. **This is the only counter-read that genuinely changes downstream architecture, even though it doesn't redirect Phase 1.**

## R5: "This is process-as-moat in a new costume — discipline-as-engineering."

**Steelman:** We just shipped an anti-pattern (process-as-moat). Now we're proposing five decision-forks, a counter-recon, an ADR backbone, a FAIL→PASS test discipline, a methodology contribution framing — all *before* writing one line of cursor code. Apply our own filter: "if you swap 'discipline' for 'process,' does the sentence still read as value-prop?" Test phrase from the recon: *"the cursor + contract work is the critical-path engineering ship."* Replace with *"the cursor + contract work is the critical-path process ship."* It still kind of works, which means the framing is hugging the boundary.

**Counter-evidence:**
- **The cursor IS the engineering ship.** Persistent state for restart-survival is a load-bearing piece of infrastructure code, not a methodology artifact. The proof: an isolate restart today loses queue state. After the cursor lands, it doesn't. That's a measurable behavior change, not a discipline claim.
- The recon resolved 5 architectural forks with citations and decisions. Each fork has a concrete code-or-doc consequence. None of them are "we should be more disciplined" — they're "the state machine vocabulary is X, the runtime model is Y, the SDK surface is Z."
- The FAIL→PASS test discipline is *substrate-correctness verification*, the same shape as ADR-0011 / 0013. That's the discipline that already shipped real evidence; reusing it isn't process-inflation, it's reusing a known-working pattern.

**However:** R5 lands a partial hit on the *post* framing. If the writeup leads with "deterministic dispatch" / "pre-registered failure modes" / "methodology contribution" instead of "here's a primitive that handles these gotchas correctly and survives restarts," that's drift. **Concrete commitment for the post:** primitive-first headline; framing in the body; benchmarks in the figures; ADRs only as footnote provenance.

**Resolved as:** R5 doesn't redirect the engineering work but flags a real risk in the post's framing. The recon's § "Discipline-check" already names this. Hold the line.

## What survives as real risk

- **R4** changes Phase 2 architecture (recon already flags as ADR-0018).
- **R5** influences post-writing (constrains headline framing; the recon already names the constraint).
- **R1, R2, R3** don't redirect Phase 1; they correctly identify framing tensions that the post needs to acknowledge head-on (alternative products + alternative runtimes exist; we differentiate, we don't dominate).

## Adversarial direction: same as recon

Counter-recon does not redirect Phase 1. ADR-0017 ships the cursor + contract + bench + failure-model package as the recon outlined. Phase 2 (`resources/subscribe` alternate path) deferred to ADR-0018, with recon evidence locked in.

The post should not lead with framing. The primitive earns the headline; the framing is one paragraph in.
