// src/server/realtime-client.ts
//
// Bounded-subscription primitive: subscribe to Postgres-Changes (or
// broadcast) on a topic, collect events that match a predicate, resolve
// when either max_events have arrived or timeout_ms has elapsed. Always
// unsubscribes via finally.
//
// The RealtimeAdapter interface is the seam — production wires it to
// @supabase/supabase-js channels; tests substitute a fake.

import {
  REALTIME_LISTEN_TYPES,
  REALTIME_SUBSCRIBE_STATES,
  type RealtimeChannel,
  type RealtimePostgresChangesPayload,
  type SupabaseClient,
  createClient,
} from "@supabase/supabase-js";
import type { WatchTableInput, WatchTableOutput } from "../types/schemas.ts";
import type { CursorStore } from "./cursor.ts";

export interface ChangeEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  commit_timestamp: string;
}

export interface RealtimeAdapter {
  subscribe(opts: {
    table: string;
    onEvent: (ev: ChangeEvent) => void;
  }): Promise<void>;
  unsubscribe(): Promise<void>;
}

/**
 * Optional persistent-cursor wiring for boundedWatch (ADR-0017 § 4 +
 * batch-shape integration amendment in this same ADR's body). When supplied:
 * - Before subscribe: acquire a lease on `watcher_id`. If the lease is
 *   busy (different holder, unexpired) or the cursor is in `dlq`, throws
 *   `CURSOR_BUSY` / `CURSOR_DLQ` (caught by handleWatchTable upstream).
 * - During event collection: events whose extracted PK is ≤ the cursor's
 *   `last_processed_pk` are filtered out (defensive against substrate
 *   replay during reconnect).
 * - On exit: commit cursor with the highest-PK event seen this batch +
 *   release lease to `idle`. On subscribe/event errors: release `dlq`.
 *
 * NOT a per-event commit — that semantic requires the action contract
 * layer (separate ADR after 0017). Integration here is batch-shape:
 * cursor advances at function return, not per event.
 */
export interface BoundedWatchCursorConfig {
  store: CursorStore;
  watcher_id: string;
  /** Operator-chosen unique identifier for THIS isolate. */
  lease_holder: string;
  /** Default 30_000 ms. */
  lease_ttl_ms?: number;
  /**
   * Extracts the monotonic PK from an event for cursor advancement.
   * Operator owns serialization (ULID, ISO timestamp, padded int) — must
   * sort lexicographically.
   */
  pkExtractor: (event: ChangeEvent) => string;
  /**
   * Optional: extracts an idempotency key for dedup of replay events.
   * Defaults to pkExtractor (PK doubles as dedup key for non-replayable
   * Postgres-Changes events).
   */
  idempotencyExtractor?: (event: ChangeEvent) => string;
}

export interface BoundedWatchInput extends WatchTableInput {
  adapter: RealtimeAdapter;
  /** See BoundedWatchCursorConfig. Omit for the v0.3.x stateless behavior. */
  cursor?: BoundedWatchCursorConfig;
}

export class BoundedWatchCursorError extends Error {
  constructor(
    public readonly code: "CURSOR_BUSY" | "CURSOR_DLQ",
    message: string,
  ) {
    super(message);
    this.name = "BoundedWatchCursorError";
  }
}

function matchesEvent(ev: ChangeEvent, predicate: WatchTableInput["predicate"]): boolean {
  if (predicate.event !== "*" && ev.event !== predicate.event) return false;
  if (!predicate.filter) return true;
  const row = ev.new ?? ev.old ?? {};
  const lhs = (row as Record<string, unknown>)[predicate.filter.column];
  const rhs = predicate.filter.value;
  switch (predicate.filter.op) {
    case "eq":
      return lhs === rhs;
    case "neq":
      return lhs !== rhs;
    case "gt":
      return typeof lhs === "number" && typeof rhs === "number" && lhs > rhs;
    case "gte":
      return typeof lhs === "number" && typeof rhs === "number" && lhs >= rhs;
    case "lt":
      return typeof lhs === "number" && typeof rhs === "number" && lhs < rhs;
    case "lte":
      return typeof lhs === "number" && typeof rhs === "number" && lhs <= rhs;
    case "in":
      return Array.isArray(rhs) && rhs.includes(lhs);
  }
}

export interface SupabaseAdapterConfig {
  supabaseUrl: string;
  supabaseKey: string;
  authToken?: string; // forwarded as Authorization header for RLS
  schema?: string; // default "public"
  subscribeTimeoutMs?: number; // default 10_000
}

/**
 * Production RealtimeAdapter wired to @supabase/supabase-js. The seam keeps
 * boundedWatch testable; this is what runs in deployment.
 *
 * 10s cap on the SUBSCRIBED handshake — that ack roundtrip is part of every
 * cold start (the spec's 200-400ms cold-start figure absorbs it). authToken
 * flows through as Authorization so RLS applies natively without re-implementing
 * row policies in the skill.
 */
export function makeSupabaseAdapter(table: string, cfg: SupabaseAdapterConfig): RealtimeAdapter {
  const schema = cfg.schema ?? "public";
  // Build options conditionally — `exactOptionalPropertyTypes: true` rejects
  // assigning `undefined` to an optional field.
  const clientOpts: Parameters<typeof createClient>[2] = {
    realtime: { params: { eventsPerSecond: 20 } },
  };
  if (cfg.authToken) {
    clientOpts.global = { headers: { Authorization: `Bearer ${cfg.authToken}` } };
  }
  const client: SupabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseKey, clientOpts);
  // global.headers.Authorization flows to PostgREST but NOT to the Realtime
  // websocket — supabase-js' default _getAccessToken falls back to supabaseKey
  // (the anon key) when there's no persisted session, which is always the case
  // in Edge Function isolates. realtime.setAuth() overrides accessTokenValue
  // on the underlying RealtimeClient. Without this, RLS on Postgres-Changes
  // evaluates against the anon claims_role even when authToken is set.
  // See SupabaseClient.ts:307-340 + 534-541; smoke test in
  // tests/smoke/multi-tenant-rls.smoke.test.ts demonstrates the gap.
  if (cfg.authToken) {
    client.realtime.setAuth(cfg.authToken);
  }
  const channelName = `realtime:${schema}:${table}`;
  let channel: RealtimeChannel | null = null;

  // Realtime payloads carry `new: {}` / `old: {}` for non-applicable sides
  // (INSERT has empty old, DELETE has empty new). Our ChangeEvent contract
  // uses null for "absent" — coerce here so the matcher and downstream
  // consumers see a consistent shape.
  const toRow = (
    val: Record<string, unknown> | Partial<Record<string, unknown>> | undefined,
  ): Record<string, unknown> | null => {
    if (!val) return null;
    if (Object.keys(val).length === 0) return null;
    return val as Record<string, unknown>;
  };

  return {
    async subscribe({ onEvent }) {
      channel = client.channel(channelName);
      channel.on(
        REALTIME_LISTEN_TYPES.POSTGRES_CHANGES,
        { event: "*", schema, table },
        (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
          onEvent({
            event: payload.eventType,
            table: payload.table,
            schema: payload.schema,
            new: toRow(payload.new),
            old: toRow(payload.old),
            commit_timestamp: payload.commit_timestamp,
          });
        },
      );
      await new Promise<void>((resolve, reject) => {
        const subscribeTimeoutMs = cfg.subscribeTimeoutMs ?? 10_000;
        const timer = setTimeout(() => reject(new Error("subscribe timeout")), subscribeTimeoutMs);
        channel?.subscribe((status) => {
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            clearTimeout(timer);
            resolve();
          } else if (
            status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
            status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
            status === REALTIME_SUBSCRIBE_STATES.CLOSED
          ) {
            clearTimeout(timer);
            reject(new Error(`subscribe failed: ${status}`));
          }
        });
      });
    },
    async unsubscribe() {
      if (channel) {
        await client.removeChannel(channel);
        channel = null;
      }
    },
  };
}

export async function boundedWatch(input: BoundedWatchInput): Promise<WatchTableOutput> {
  const events: ChangeEvent[] = [];
  let resolveOnEvent: ((reason: "max_events") => void) | null = null;

  // ---------------------------------------------------------------------
  // Cursor lease acquisition (opt-in). Acquired BEFORE subscribe so a
  // busy lease can short-circuit without burning a Realtime websocket.
  // ---------------------------------------------------------------------
  let cursorWatermark = ""; // PK threshold for the substrate-replay filter
  if (input.cursor) {
    const { store, watcher_id, lease_holder } = input.cursor;
    const lease_ttl_ms = input.cursor.lease_ttl_ms ?? 30_000;
    const acquired = await store.acquire(watcher_id, lease_holder, lease_ttl_ms);
    if (!acquired.acquired) {
      const reason = acquired.row.status === "dlq" ? "CURSOR_DLQ" : "CURSOR_BUSY";
      throw new BoundedWatchCursorError(
        reason,
        `cursor ${watcher_id} is ${reason === "CURSOR_DLQ" ? "in dlq (terminal)" : `held by ${acquired.row.lease_holder}`}`,
      );
    }
    cursorWatermark = acquired.row.last_processed_pk;
  }

  const eventArrived = new Promise<"max_events">((resolve) => {
    resolveOnEvent = resolve;
  });

  const onEvent = (ev: ChangeEvent) => {
    if (!matchesEvent(ev, input.predicate)) return;
    // Cursor watermark filter: skip events whose PK is <= the cursor's
    // last_processed_pk (defensive against substrate replay on reconnect).
    if (input.cursor && cursorWatermark !== "") {
      const pk = input.cursor.pkExtractor(ev);
      if (pk <= cursorWatermark) return;
    }
    // Hard cap: max_events is the max events stored, regardless of how the
    // adapter delivers them. Without this guard, a synchronous burst (or a
    // websocket frame carrying multiple changes) overflows the cap because
    // unsubscribe doesn't run until after Promise.race resolves.
    if (events.length >= input.max_events) return;
    events.push(ev);
    if (events.length >= input.max_events && resolveOnEvent) {
      resolveOnEvent("max_events");
      resolveOnEvent = null;
    }
  };

  // Subscribe inside a try/catch so any failure releases the lease to dlq
  // (release(idle) on success path; release(dlq) on error path).
  try {
    await input.adapter.subscribe({ table: input.table, onEvent });
  } catch (err) {
    if (input.cursor) {
      await input.cursor.store
        .release(input.cursor.watcher_id, input.cursor.lease_holder, "dlq", "subscribe_failed")
        .catch(() => {
          /* best-effort release; caller surfaces the original subscribe error */
        });
    }
    throw err;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), input.timeout_ms);
    });
    const closed_reason = await Promise.race([eventArrived, timeoutPromise]);

    // Cursor commit + release on success path (after we know what we collected).
    if (input.cursor && events.length > 0) {
      const cursor = input.cursor;
      // Pick the lexicographically-highest PK we saw this batch.
      let highestPk = "";
      let highestEvent: ChangeEvent | null = null;
      for (const ev of events) {
        const pk = cursor.pkExtractor(ev);
        if (pk > highestPk) {
          highestPk = pk;
          highestEvent = ev;
        }
      }
      if (highestEvent) {
        const idempExtract = cursor.idempotencyExtractor ?? cursor.pkExtractor;
        await cursor.store.commit(cursor.watcher_id, cursor.lease_holder, {
          last_processed_pk: highestPk,
          last_processed_at: highestEvent.commit_timestamp,
          idempotency_key: idempExtract(highestEvent),
        });
      }
    }
    if (input.cursor) {
      await input.cursor.store.release(input.cursor.watcher_id, input.cursor.lease_holder, "idle");
    }

    return { events, closed_reason };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    await input.adapter.unsubscribe();
  }
}

// ---------------------------------------------------------------------------
// Broadcast adapter — mirrors the postgres-changes shape above for the
// Realtime broadcast channel type. event_filter is client-side: realtime-js'
// broadcast surface accepts a single event filter on `on(...)`, but bounding
// to a literal event would force a separate adapter per filter and lose the
// "subscribe once, observe many" shape. We listen with `event: "*"` and let
// boundedSubscribe filter — the double-filter (here + below) is defensive
// and harmless when no filter is supplied.
// ---------------------------------------------------------------------------

export interface BroadcastReceived {
  channel: string;
  event: string;
  payload: Record<string, unknown>;
  received_at: string;
}

export interface BroadcastAdapter {
  subscribe(opts: {
    channel: string;
    event_filter?: string;
    private?: boolean;
    onBroadcast: (b: BroadcastReceived) => void;
  }): Promise<void>;
  unsubscribe(): Promise<void>;
}

export async function boundedSubscribe(input: {
  adapter: BroadcastAdapter;
  channel: string;
  event_filter?: string;
  private?: boolean;
  timeout_ms: number;
  max_events: number;
}): Promise<{ broadcasts: BroadcastReceived[]; closed_reason: "max_events" | "timeout" }> {
  const broadcasts: BroadcastReceived[] = [];
  let resolveOnEvent: ((reason: "max_events") => void) | null = null;

  const arrived = new Promise<"max_events">((resolve) => {
    resolveOnEvent = resolve;
  });

  await input.adapter.subscribe({
    channel: input.channel,
    ...(input.event_filter !== undefined ? { event_filter: input.event_filter } : {}),
    ...(input.private !== undefined ? { private: input.private } : {}),
    onBroadcast: (b) => {
      if (input.event_filter && b.event !== input.event_filter) return;
      broadcasts.push(b);
      if (broadcasts.length >= input.max_events && resolveOnEvent) {
        resolveOnEvent("max_events");
        resolveOnEvent = null;
      }
    },
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), input.timeout_ms);
    });
    const closed_reason = await Promise.race([arrived, timeoutPromise]);
    return { broadcasts, closed_reason };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    await input.adapter.unsubscribe();
  }
}

// realtime-js' broadcast `on(..., { event: "*" }, cb)` overload calls cb with
// `{ type: "broadcast", event: string, meta?, [key: string]: any }`. We type
// the parameter as a structural subset so noExplicitAny doesn't fire — and so
// future SDK shape drift (extra fields on the wildcard payload) doesn't
// silently break compilation.
type SupabaseBroadcastPayload = {
  type: string;
  event: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
};

export function makeSupabaseBroadcastAdapter(cfg: SupabaseAdapterConfig): BroadcastAdapter {
  // exactOptionalPropertyTypes: true rejects `{ global: undefined }`. Build
  // options conditionally — same pattern as makeSupabaseAdapter above.
  const clientOpts: Parameters<typeof createClient>[2] = {};
  if (cfg.authToken) {
    clientOpts.global = { headers: { Authorization: `Bearer ${cfg.authToken}` } };
  }
  const client: SupabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseKey, clientOpts);
  // See identical setAuth note above on makeSupabaseAdapter — Broadcast
  // Authorization on private channels also reads the JWT off the websocket,
  // so the same fix applies here.
  if (cfg.authToken) {
    client.realtime.setAuth(cfg.authToken);
  }
  let channel: RealtimeChannel | null = null;

  return {
    async subscribe({ channel: name, private: isPrivate, onBroadcast }) {
      channel = isPrivate
        ? client.channel(name, { config: { private: true } })
        : client.channel(name);
      channel.on(
        REALTIME_LISTEN_TYPES.BROADCAST,
        { event: "*" },
        (msg: SupabaseBroadcastPayload) => {
          onBroadcast({
            channel: name,
            event: msg.event,
            payload: (msg.payload ?? {}) as Record<string, unknown>,
            received_at: new Date().toISOString(),
          });
        },
      );
      await new Promise<void>((resolve, reject) => {
        const subscribeTimeoutMs = cfg.subscribeTimeoutMs ?? 10_000;
        const timer = setTimeout(() => reject(new Error("subscribe timeout")), subscribeTimeoutMs);
        channel?.subscribe((status) => {
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            clearTimeout(timer);
            resolve();
          } else if (
            status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
            status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
            status === REALTIME_SUBSCRIBE_STATES.CLOSED
          ) {
            clearTimeout(timer);
            reject(new Error(`subscribe failed: ${status}`));
          }
        });
      });
    },
    async unsubscribe() {
      if (channel) {
        await client.removeChannel(channel);
        channel = null;
      }
    },
  };
}
