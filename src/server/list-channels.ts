import { ToolError } from "../types/errors.ts";
import { ListChannelsInputSchema, type ListChannelsOutput } from "../types/schemas.ts";

export interface ChannelRegistryEntry {
  name: string;
  member_count: number;
  last_event_at: string | null;
}

export interface ListChannelsDeps {
  registry: () => Promise<ChannelRegistryEntry[]>;
}

export async function handleListChannels(
  rawInput: unknown,
  deps: ListChannelsDeps,
): Promise<ListChannelsOutput> {
  const parsed = ListChannelsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ToolError("INVALID_CHANNEL", "list_channels takes no arguments", {
      issues: parsed.error.issues,
    });
  }
  const channels = await deps.registry();
  return { channels };
}
