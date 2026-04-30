// tests/smoke/describe-table.smoke.test.ts
//
// End-to-end validation that handleDescribeTable composes a correct
// TableIntrospection from real pg_catalog / information_schema queries
// against a Supabase branch. Skips automatically when EVAL_SUPABASE_PAT
// or EVAL_HOST_PROJECT_REF is missing.

import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { type TableIntrospection, handleDescribeTable } from "../../src/server/describe-table.ts";
import { buildBranchPoolerUrl, withBranch } from "../../vendor/foundation/branch.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

async function pgIntrospect(
  sql: ReturnType<typeof postgres>,
  table: string,
): Promise<TableIntrospection | null> {
  const cols = await sql<
    { column_name: string; data_type: string; nullable: boolean; generated: boolean }[]
  >`
    select column_name, data_type, is_nullable = 'YES' as nullable, is_generated = 'ALWAYS' as generated
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  if (cols.length === 0) return null;
  const pk = await sql<{ column_name: string }[]>`
    select kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu using (constraint_schema, constraint_name)
    where tc.table_schema = 'public' and tc.table_name = ${table} and tc.constraint_type = 'PRIMARY KEY'
    order by kcu.ordinal_position
  `;
  const rls = await sql<{ relrowsecurity: boolean }[]>`
    select c.relrowsecurity
    from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const replIdent = await sql<{ relreplident: string }[]>`
    select c.relreplident from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const replMap: Record<string, "default" | "full" | "index" | "nothing"> = {
    d: "default",
    f: "full",
    i: "index",
    n: "nothing",
  };
  const replKey = replIdent[0]?.relreplident ?? "d";
  const replication_identity = replMap[replKey] ?? "default";
  return {
    schema: "public",
    columns: cols.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.nullable,
      generated: c.generated,
    })),
    primary_key: pk.map((r) => r.column_name),
    rls_enabled: rls[0]?.relrowsecurity ?? false,
    replication_identity,
  };
}

describe.skipIf(!SHOULD_RUN)("describe_table_changes smoke", () => {
  it("introspects a table created on the branch", async () => {
    const apiClient = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      apiClient,
      { name: `smoke-desc-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ details }) => {
        const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
        const sql = postgres(dbUrl, { max: 1, prepare: false });
        try {
          await sql`create table widgets (id uuid primary key default gen_random_uuid(), name text not null)`;
          await sql`alter table widgets replica identity full`;
          const result = await handleDescribeTable(
            { table: "widgets" },
            { introspect: (t) => pgIntrospect(sql, t) },
          );
          expect(result.primary_key).toEqual(["id"]);
          expect(result.replication_identity).toBe("full");
          expect(result.columns.find((c) => c.name === "name")?.nullable).toBe(false);
        } finally {
          await sql.end();
        }
      },
    );
  }, 300_000);
});
