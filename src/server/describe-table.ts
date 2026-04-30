import { ToolError } from "../types/errors.ts";
import { DescribeTableInputSchema, type DescribeTableOutput } from "../types/schemas.ts";

export interface TableIntrospection {
  schema: string;
  columns: { name: string; type: string; nullable: boolean; generated: boolean }[];
  primary_key: string[];
  rls_enabled: boolean;
  replication_identity: "default" | "full" | "index" | "nothing";
}

export interface DescribeTableDeps {
  introspect: (table: string) => Promise<TableIntrospection | null>;
}

export async function handleDescribeTable(
  rawInput: unknown,
  deps: DescribeTableDeps,
): Promise<DescribeTableOutput> {
  const parsed = DescribeTableInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ToolError("INVALID_TABLE", parsed.error.message, {
      issues: parsed.error.issues,
    });
  }
  const intro = await deps.introspect(parsed.data.table);
  if (!intro) {
    throw new ToolError("INVALID_TABLE", `table not found: ${parsed.data.table}`);
  }
  return {
    table: parsed.data.table,
    schema: intro.schema,
    columns: intro.columns,
    primary_key: intro.primary_key,
    rls_enabled: intro.rls_enabled,
    replication_identity: intro.replication_identity,
  };
}
