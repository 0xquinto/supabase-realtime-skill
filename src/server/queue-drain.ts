// src/server/queue-drain.ts
//
// boundedQueueDrain: deterministic module composing boundedWatch +
// handleBroadcast + a caller-supplied ack callback to drain a queue/outbox
// table. Single drain pass with safety budgets (timeout + max_events). See
// docs/decisions/0010-bounded-queue-drain.md.
//
// IMPORTANT — semantics: at-least-once. Each row may be forwarded more than
// once if the broadcast succeeds but the ack callback fails. Subscribers
// MUST be idempotent. To upgrade to effectively-once, the operator runs a
// consumer-side inbox table (out of scope for v0.2.0).
//
// Note on the DLQ surface: ADR-0010 § 3 commits to an optional
// `dead_letter_table` parameter. v0.2.0 ships the more disciplined shape —
// a `dead_letter` callback — to avoid the module taking a SQL client
// dependency it doesn't otherwise need. The reference page documents the
// canonical SQL wiring; operators can pass postgres-js / prisma / fetch /
// whatever closes over their storage choice. Same outcome, narrower module
// surface. Worth promoting to a typed `dead_letter_table: { client, name }`
// in v0.3.0 if the callback shape proves to be papering over a real
// missing primitive.

import type { WatchTableInput } from "../types/schemas.ts";
import { handleBroadcast } from "./broadcast.ts";
import type { BroadcastSender } from "./broadcast.ts";
import { type ChangeEvent, type RealtimeAdapter, boundedWatch } from "./realtime-client.ts";

/**
 * The shape of one row extracted from a queue event for fan-out.
 * Operators map their schema to this via {@link BoundedQueueDrainInput.read_row}.
 */
export interface QueueRow {
  destination: string;
  event: string;
  payload: Record<string, unknown>;
}

export interface BoundedQueueDrainInput {
  /** Same seam boundedWatch uses — production: makeSupabaseAdapter; tests: a fake. */
  adapter: RealtimeAdapter;

  /** Queue/outbox table to drain. */
  table: string;

  /** Optional predicate forwarded to boundedWatch. Defaults to `{ event: "INSERT" }`. */
  predicate?: WatchTableInput["predicate"];

  /** Maps a change event to the broadcast payload (destination + event + payload). */
  read_row: (ev: ChangeEvent) => QueueRow;

  /**
   * Called once per successfully-forwarded row. The canonical implementation
   * runs a SQL UPDATE setting forwarded_at = now(). At-least-once: if this
   * throws after a successful broadcast, the row will be forwarded again on
   * the next drain loop.
   */
  ack: (ev: ChangeEvent, row: QueueRow) => Promise<void>;

  /**
   * Called when handleBroadcast throws after its 3 internal retries. If
   * provided, the module routes the row to this callback (canonical: SQL
   * INSERT into a DLQ table). If omitted, the row stays un-acked and will
   * be retried on the next drain loop — operator's responsibility to bound
   * retries elsewhere (e.g., an `attempts` column + filter on the predicate).
   */
  dead_letter?: (ev: ChangeEvent, row: QueueRow, error: unknown) => Promise<void>;

  /** Same broadcast sender shape handleBroadcast uses elsewhere. */
  sender: BroadcastSender;

  /** Timeout for the bounded drain pass. Forwarded to boundedWatch. */
  timeout_ms: number;

  /** Hard cap on rows to drain in this pass. Forwarded to boundedWatch. */
  max_events: number;
}

export interface BoundedQueueDrainOutput {
  /** Successfully broadcast AND acked. */
  forwarded: number;

  /** Broadcast failed all retries; routed to dead_letter callback. */
  dead_lettered: number;

  /**
   * Broadcast failed all retries AND no dead_letter callback was provided.
   * Row remains un-acked; will be observed on next drain loop.
   */
  failed: number;

  /** From boundedWatch. */
  closed_reason: "max_events" | "timeout";
}

const NOT_IMPLEMENTED =
  "boundedQueueDrain: contract scaffold landed; implementation pending fixtures-then-body per ADR-0010 § Migration steps 1→2. See docs/decisions/0010-bounded-queue-drain.md.";

export async function boundedQueueDrain(
  _input: BoundedQueueDrainInput,
): Promise<BoundedQueueDrainOutput> {
  // Suppress "imported but unused" until the body lands. These imports are
  // load-bearing for the contract and the implementation will use them on
  // the next commit; pulling them out now would just reshuffle the diff.
  void boundedWatch;
  void handleBroadcast;
  throw new Error(NOT_IMPLEMENTED);
}
