export type ToolErrorCode =
  | "INVALID_TABLE"
  | "INVALID_PREDICATE"
  | "INVALID_CHANNEL"
  | "INVALID_PAYLOAD"
  | "TIMEOUT_EXCEEDED_CAP"
  | "RLS_DENIED"
  | "UPSTREAM_ERROR";

export class ToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}
