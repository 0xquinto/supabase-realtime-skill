// eval/probe-edge-payload.ts
//
// One-shot diagnostic: when watch_table is invoked through the deployed
// Edge Function vs against the host project directly via supabase-js, do
// the postgres_changes events carry `new` populated, or is `new: null`?
//
// Spike T7-Edge surfaced `new: null` on every delivered event from the
// deployed function. This probe narrows the cause:
//   - Probe A: raw supabase-js → `postgres_changes` directly against host
//     project. Two tables, replica identity DEFAULT vs FULL.
//   - Probe B: same payload via the deployed Edge function (matches T7-Edge
//     spike's wiring).
//
// If Probe A shows `new` populated but Probe B doesn't → the bug is in the
// deployed bundle's transport / per-request server lifecycle.
//
// If Probe A also shows `new: null` → it's substrate (Realtime broker, host
// project tenant config, or supabase-js itself in the npm-published shape).
//
// If FULL populates and DEFAULT doesn't → unusual (INSERT events shouldn't
// depend on replica identity), but it'd be a clean answer.
//
// Run:
//   set -a && source .env && set +a && bun run eval/probe-edge-payload.ts

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { fetchProjectKeys } from "../tests/smoke/_helpers/project-keys.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const HOST_DB_URL = process.env.EVAL_HOST_DB_URL;

if (!PAT || !HOST_REF || !HOST_DB_URL) {
  console.error("[probe] missing EVAL_SUPABASE_PAT / EVAL_HOST_PROJECT_REF / EVAL_HOST_DB_URL");
  process.exit(2);
}

async function fetchSecretKey(pat: string, ref: string): Promise<string> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  const keys = (await res.json()) as Array<{ name?: string; type?: string; api_key?: string }>;
  const secret = keys.find((k) => k.type === "secret")?.api_key;
  if (!secret) throw new Error(`no secret-type api key for ${ref}`);
  return secret;
}

interface ProbeRow {
  probe: string;
  table: string;
  identity: string;
  events_received: number;
  first_event_new: unknown;
  first_event_old: unknown;
  first_event_commit_timestamp: unknown;
  raw_first_event: unknown;
}

const ts = Date.now();
const probes = [
  // Final variant: GRANT SELECT under anon JWT (the consumer contract).
  // If this populates `new`, the v1.0.0 smoke can use anon-with-GRANT directly.
  {
    probe: "F_granted_anon",
    identity: "full",
    auth: "legacy_anon",
    grant: true,
    rls: false,
  },
  {
    probe: "G_granted_rls_anon",
    identity: "full",
    auth: "legacy_anon",
    grant: true,
    rls: true,
  },
] as const;

const results: ProbeRow[] = [];

const sql = postgres(HOST_DB_URL as string, { max: 1, prepare: false });
const keys = await fetchProjectKeys(PAT as string, HOST_REF as string);
const secretKey = await fetchSecretKey(PAT as string, HOST_REF as string);
console.log(
  `[probe] keys: legacy.serviceRole=${keys.serviceRole.slice(0, 12)}... secret=${secretKey.slice(0, 12)}...`,
);

try {
  // Defensive cleanup of any leftover probe tables.
  const stale = await sql<Array<{ tablename: string }>>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename like 'probe_payload_%'
  `;
  for (const { tablename } of stale) {
    await sql.unsafe(`alter publication supabase_realtime drop table ${tablename}`).catch(() => {});
    await sql.unsafe(`drop table if exists ${tablename}`).catch(() => {});
  }

  for (const p of probes) {
    const table = `probe_payload_${ts}_${p.identity}`;
    console.log(`\n=== ${p.probe} (table=${table}, replica identity=${p.identity}) ===`);

    await sql.unsafe(
      `create table ${table} (id uuid primary key default gen_random_uuid(), body text, n int)`,
    );
    if (p.identity === "full") {
      await sql.unsafe(`alter table ${table} replica identity full`);
    }
    if (p.grant) {
      await sql.unsafe(`grant select on ${table} to anon, authenticated, service_role`);
    }
    if (p.rls) {
      await sql.unsafe(`alter table ${table} enable row level security`);
      await sql.unsafe(`create policy "${table}_read" on ${table} for select using (true)`);
    }
    await sql.unsafe(`alter publication supabase_realtime add table ${table}`);

    const auth: string = p.auth;
    const bearer = auth === "legacy_anon" ? keys.anon : keys.serviceRole;
    const sb = createClient(`https://${HOST_REF as string}.supabase.co`, bearer);
    void secretKey;
    const events: unknown[] = [];
    const channel = sb.channel(`probe-${table}`).on(
      // biome-ignore lint/suspicious/noExplicitAny: supabase-js postgres_changes typing is generic-shy
      "postgres_changes" as any,
      { event: "INSERT", schema: "public", table },
      (payload: unknown) => {
        events.push(payload);
      },
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("subscribe timed out at 8s")), 8000);
      channel.subscribe((status, err) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve();
        }
        if (err || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          clearTimeout(timer);
          reject(err ?? new Error(`subscribe status=${status}`));
        }
      });
    });
    console.log("[probe] subscribed, waiting 6s for warm-up window");

    await new Promise((r) => setTimeout(r, 6_000));

    console.log("[probe] firing INSERT");
    await sql.unsafe(`insert into ${table} (body, n) values ('hello', 42)`);

    await new Promise((r) => setTimeout(r, 3_000));

    const first = events[0] as
      | { new?: unknown; old?: unknown; commit_timestamp?: unknown }
      | undefined;
    const row: ProbeRow = {
      probe: p.probe,
      table,
      identity: p.identity,
      events_received: events.length,
      first_event_new: first?.new ?? null,
      first_event_old: first?.old ?? null,
      first_event_commit_timestamp: first?.commit_timestamp ?? null,
      raw_first_event: first ?? null,
    };
    results.push(row);
    console.log(`[probe] events=${events.length}, first event:`);
    console.log(JSON.stringify(first, null, 2));

    await channel.unsubscribe();
    await sb.removeAllChannels();
    await sql.unsafe(`alter publication supabase_realtime drop table ${table}`).catch(() => {});
    await sql.unsafe(`drop table if exists ${table}`).catch(() => {});
  }
} finally {
  await sql.end();
}

console.log("\n=== Summary ===");
for (const r of results) {
  const newPopulated = r.first_event_new && Object.keys(r.first_event_new).length > 0;
  console.log(
    `  ${r.probe.padEnd(30)} events=${r.events_received} new=${newPopulated ? "POPULATED" : "null/empty"}`,
  );
}

process.exit(0);
