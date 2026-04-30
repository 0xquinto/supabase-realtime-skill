// src/foundation/transcript.ts
//
// Maps an Anthropic SDK `messages` history into a flat list of ToolCall
// objects, each pairing one tool_use block with its tool_result block.
// Pending = no matching result yet (e.g., interrupted run).

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result: string | null;
  error: string | null;
  pending: boolean;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | unknown;
  is_error?: boolean;
}

interface MessageLike {
  role: string;
  content: string | Array<unknown>;
}

function isToolUse(block: unknown): block is ToolUseBlock {
  return (
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === "tool_use"
  );
}

function isToolResult(block: unknown): block is ToolResultBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "tool_result"
  );
}

function blockContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "object" && c !== null && "text" in c
          ? String((c as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return JSON.stringify(content);
}

export function parseTranscript(messages: MessageLike[]): ToolCall[] {
  const uses = new Map<string, ToolUseBlock>();
  const results = new Map<string, ToolResultBlock>();

  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (isToolUse(block)) {
        uses.set(block.id, block);
      } else if (isToolResult(block)) {
        results.set(block.tool_use_id, block);
      }
    }
  }

  const calls: ToolCall[] = [];
  for (const [id, use] of uses) {
    const result = results.get(id);
    if (result === undefined) {
      calls.push({
        id,
        name: use.name,
        arguments: use.input,
        result: null,
        error: null,
        pending: true,
      });
    } else if (result.is_error === true) {
      calls.push({
        id,
        name: use.name,
        arguments: use.input,
        result: null,
        error: blockContentToString(result.content),
        pending: false,
      });
    } else {
      calls.push({
        id,
        name: use.name,
        arguments: use.input,
        result: blockContentToString(result.content),
        error: null,
        pending: false,
      });
    }
  }
  return calls;
}
