import { ToolError } from "../types/errors";
import {
  type WatchTableInput,
  WatchTableInputSchema,
  type WatchTableOutput,
} from "../types/schemas";
import { type RealtimeAdapter, boundedWatch } from "./realtime-client";

export interface WatchTableDeps {
  adapterFor(table: string): RealtimeAdapter;
}

export async function handleWatchTable(
  rawInput: unknown,
  deps: WatchTableDeps,
): Promise<WatchTableOutput> {
  const parsed = WatchTableInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path.includes("timeout_ms") && issue.code === "too_big") {
      throw new ToolError("TIMEOUT_EXCEEDED_CAP", "timeout_ms exceeds 120000ms cap", {
        max: 120_000,
      });
    }
    throw new ToolError("INVALID_PREDICATE", parsed.error.message, { issues: parsed.error.issues });
  }
  const input: WatchTableInput = parsed.data;
  const adapter = deps.adapterFor(input.table);
  return boundedWatch({ adapter, ...input });
}
