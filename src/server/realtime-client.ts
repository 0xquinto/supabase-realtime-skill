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

export interface BoundedWatchInput extends WatchTableInput {
  adapter: RealtimeAdapter;
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

  const eventArrived = new Promise<"max_events">((resolve) => {
    resolveOnEvent = resolve;
  });

  const onEvent = (ev: ChangeEvent) => {
    if (!matchesEvent(ev, input.predicate)) return;
    events.push(ev);
    if (events.length >= input.max_events && resolveOnEvent) {
      resolveOnEvent("max_events");
      resolveOnEvent = null;
    }
  };

  await input.adapter.subscribe({ table: input.table, onEvent });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), input.timeout_ms);
    });
    const closed_reason = await Promise.race([eventArrived, timeoutPromise]);
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
    onBroadcast: (b: BroadcastReceived) => void;
  }): Promise<void>;
  unsubscribe(): Promise<void>;
}

export async function boundedSubscribe(input: {
  adapter: BroadcastAdapter;
  channel: string;
  event_filter?: string;
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
  let channel: RealtimeChannel | null = null;

  return {
    async subscribe({ channel: name, onBroadcast }) {
      channel = client.channel(name);
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
