import { ToolError } from "../types/errors.ts";
import {
  type SubscribeChannelInput,
  SubscribeChannelInputSchema,
  type SubscribeChannelOutput,
} from "../types/schemas.ts";
import { type BroadcastAdapter, boundedSubscribe } from "./realtime-client.ts";

export interface SubscribeDeps {
  adapterFor(channel: string): BroadcastAdapter;
}

export async function handleSubscribe(
  rawInput: unknown,
  deps: SubscribeDeps,
): Promise<SubscribeChannelOutput> {
  const parsed = SubscribeChannelInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path.includes("timeout_ms") && issue.code === "too_big") {
      throw new ToolError("TIMEOUT_EXCEEDED_CAP", "timeout_ms exceeds 120000ms cap", {
        max: 120_000,
      });
    }
    throw new ToolError("INVALID_CHANNEL", parsed.error.message, {
      issues: parsed.error.issues,
    });
  }
  const input: SubscribeChannelInput = parsed.data;
  const adapter = deps.adapterFor(input.channel);
  // Spread the discrete fields rather than `...input` — exactOptionalPropertyTypes
  // rejects `event_filter: undefined` flowing into a non-undefined-typed slot.
  return boundedSubscribe({
    adapter,
    channel: input.channel,
    timeout_ms: input.timeout_ms,
    max_events: input.max_events,
    ...(input.event_filter !== undefined ? { event_filter: input.event_filter } : {}),
    ...(input.private !== undefined ? { private: input.private } : {}),
  });
}
