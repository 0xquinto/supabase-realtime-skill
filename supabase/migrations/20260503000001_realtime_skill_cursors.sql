-- supabase/migrations/20260503000001_realtime_skill_cursors.sql
--
-- Cursor table for boundedWatch persistent state — design per ADR-0017.
--
-- One row per watcher_id (operator-chosen, stable across isolate restarts).
-- The state machine and persistence contract are documented in
-- docs/decisions/0017-bounded-watch-cursor.md; this file is the canonical
-- schema for operators who want to ship the production cursor store.
--
-- Operators who don't need restart-survival can skip this migration
-- entirely and use makeInMemoryCursorStore() — the boundedWatch primitive
-- works without a cursor (current stateless mode is unchanged).
--
-- This migration is OPT-IN for v0.3.x consumers. Smoke tests at
-- tests/smoke/cursor-restart.smoke.test.ts create the same shape inline
-- (host project's `public` schema is empty by default — see CLAUDE.md
-- § "Host project's `public` schema is empty by default").

create table if not exists realtime_skill_cursors (
  -- Identity
  watcher_id text primary key,

  -- Cursor state (advances only on action-success commit; RisingWave#25071 lesson)
  last_processed_pk text not null default '',
  last_processed_at timestamptz,
  idempotency_key text not null default '',

  -- State machine: idle → leased → committed | dlq
  status text not null default 'idle' check (status in ('idle', 'leased', 'committed', 'dlq')),

  -- Lease (soft-lock; null when idle)
  lease_holder text,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,

  -- Retry accounting (resets to 0 on commit)
  attempts integer not null default 0,

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for operators that scan for stuck/expired leases (e.g., a janitor job
-- that releases leases past their lease_expires_at without moving to dlq).
-- Not used by the CursorStore acquire/commit paths (those access by primary
-- key); included for operational queries.
create index if not exists realtime_skill_cursors_lease_expires_at_idx
  on realtime_skill_cursors (lease_expires_at)
  where status = 'leased';

comment on table realtime_skill_cursors is
  'Persistent cursor for boundedWatch. See docs/decisions/0017-bounded-watch-cursor.md.';
comment on column realtime_skill_cursors.idempotency_key is
  'Most-recently committed key — for dedup of retries that arrive after a successful commit but before lease release. Computed by the user''s action contract dedupKey callback.';
comment on column realtime_skill_cursors.last_processed_pk is
  'Lexicographically monotonic. Operator owns serialization (ULID, ISO timestamp, padded int).';
