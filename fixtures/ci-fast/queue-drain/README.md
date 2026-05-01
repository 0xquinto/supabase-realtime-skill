# Queue-drain fixture corpus (ci-fast seeds)

Hand-curated seed fixtures for `boundedQueueDrain`. Mirrors the discipline of `fixtures/ci-fast/` (the triage corpus) — seed by hand, synthesize later only against a hand-crafted base.

Each fixture is one binary trial of the `forward_correctness_rate_min` metric (ADR-0010): did the drain leave the queue in the correct end-state given the rows that arrived and the broadcast behavior?

## Format

```jsonc
{
  "id": "qd00N-short-slug",
  "description": "Plain-English summary of what this fixture tests.",
  "drain_config": {
    "timeout_ms": 5000,
    "max_events": 10,
    "dead_letter_provided": true   // does the BoundedQueueDrainInput include a dead_letter callback?
  },
  "rows_arriving": [               // rows that the test harness will emit via the fake adapter
    { "id": "row-1", "destination": "slack:eng", "event_type": "deploy.done", "payload": {...} },
    ...
  ],
  "broadcast_behavior":            // how the fake BroadcastSender behaves
    | "always_success"             //   every row's broadcast succeeds
    | "always_fail"                //   every row's broadcast fails permanently
    | { "fail_first_n_attempts_for_row": "row-X", "n": 2 }  //   transient failure for one row
    | { "permanently_fail_row": "row-X" }                   //   one specific row poisons
    | { "permanently_fail_destinations": ["slack:dead"] }   //   one specific destination poisons
  ,
  "expected_end_state": {
    "forwarded": 3,
    "dead_lettered": 0,
    "failed": 0,
    "closed_reason_one_of": ["max_events", "timeout"]   // either is acceptable depending on timing
  }
}
```

## Why these seeds

ADR-0010 § "Predicted effect" names the load-bearing failure categories: **poison rows, transient failures, idempotency-key collisions, drain-condition boundaries**. The 7 seeds below cover those categories binary-style:

| Seed | Category | What it falsifies if it fails |
|---|---|---|
| `qd001` | Clean drain (happy path) | "the loop forwards every successful broadcast" |
| `qd002` | Poison row → DLQ callback fires | "the dead_letter callback is invoked on permanent failure" |
| `qd003` | Poison row, no DLQ → row counted as failed | "without a DLQ callback, the row stays in the queue (failed counter ↑)" |
| `qd004` | Transient failure → retry-success (handleBroadcast's 3 internal retries) | "transient broadcast errors don't escalate to DLQ when retry exhausts the upstream's hiccup" |
| `qd005` | Timeout, zero rows | "drain returns cleanly with closed_reason=timeout" |
| `qd006` | max_events cap | "drain closes at max_events; remaining rows stay in the queue (not in failed/DLQ)" |
| `qd007` | Mixed: one success + one poison → DLQ | "the loop doesn't abort on a single poison row; remaining rows still drain" |

## Idempotency-key collisions

The recon's predicted-effect statement names "idempotency-key collisions" as a category. Deferred from this seed because the property is **operator-side**: `boundedWatch` delivers each change event once; the operator's broadcast subscriber must be idempotent if downstream re-delivery is possible. The module itself doesn't claim idempotency — that's the at-least-once contract surface (ADR-0010 § 4). Adding a fixture here would test an empty assertion against the module.

## Synthesis path (out of scope here)

These 7 seeds are the **seed corpus**. The full ci-fast tier (n=20) would add ~13 more by structured variation (different row counts, different destination shapes, different timing edges). The ci-full tier (n=100; eventual n=300 per ADR-0007) would synthesize from these + the ci-fast variants the same way `fixtures/ci-fast/` was extended for the triage corpus (see ADR-0006 / synthesizer at `eval/synthesize-fixtures.ts`).

## Status

Seed only. The runner that consumes these fixtures lands alongside the `boundedQueueDrain` implementation on the next commit (ADR-0010 § Migration step 2).
