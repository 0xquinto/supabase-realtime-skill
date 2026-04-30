import { ToolError } from "../types/errors.ts";
import {
  type BroadcastInput,
  BroadcastInputSchema,
  type BroadcastOutput,
} from "../types/schemas.ts";

export interface BroadcastSender {
  send(input: BroadcastInput): Promise<{ status: "ok" }>;
}

export interface BroadcastDeps {
  sender: BroadcastSender;
}

const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 200;

export async function handleBroadcast(
  rawInput: unknown,
  deps: BroadcastDeps,
): Promise<BroadcastOutput> {
  const parsed = BroadcastInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const overSize = parsed.error.issues.find((i) => i.message.includes("32KB"));
    if (overSize) {
      throw new ToolError("INVALID_PAYLOAD", "payload exceeds 32KB cap", { cap: 32_768 });
    }
    throw new ToolError("INVALID_PAYLOAD", parsed.error.message, { issues: parsed.error.issues });
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try {
      await deps.sender.send(parsed.data);
      return { success: true };
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_LIMIT - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }
  throw new ToolError("UPSTREAM_ERROR", `broadcast failed after ${RETRY_LIMIT} attempts`, {
    cause: String(lastErr),
  });
}
