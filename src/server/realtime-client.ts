// src/server/realtime-client.ts
//
// Bounded-subscription primitive: subscribe to Postgres-Changes (or
// broadcast) on a topic, collect events that match a predicate, resolve
// when either max_events have arrived or timeout_ms has elapsed. Always
// unsubscribes via finally.
//
// The RealtimeAdapter interface is the seam — production wires it to
// @supabase/supabase-js channels; tests substitute a fake.

import type { WatchTableInput, WatchTableOutput } from "../types/schemas";

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

  try {
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), input.timeout_ms),
    );
    const closed_reason = await Promise.race([eventArrived, timeoutPromise]);
    return { events, closed_reason };
  } finally {
    await input.adapter.unsubscribe();
  }
}
