import { describe, expect, it, vi } from "vitest";
import { handleBroadcast } from "../../src/server/broadcast.ts";

describe("handleBroadcast", () => {
  it("returns success on a clean send", async () => {
    const send = vi.fn(async () => ({ status: "ok" as const }));
    const result = await handleBroadcast(
      { channel: "c", event: "e", payload: { x: 1 } },
      { sender: { send } },
    );
    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries up to 3 times on 5xx-shaped failures", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("upstream 503");
      return { status: "ok" as const };
    });
    const result = await handleBroadcast(
      { channel: "c", event: "e", payload: { x: 1 } },
      { sender: { send } },
    );
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up after 3 failures and throws UPSTREAM_ERROR", async () => {
    const send = vi.fn(async () => {
      throw new Error("upstream 503");
    });
    await expect(
      handleBroadcast({ channel: "c", event: "e", payload: {} }, { sender: { send } }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects payload over 32KB with INVALID_PAYLOAD", async () => {
    const send = vi.fn(async () => ({ status: "ok" as const }));
    const huge = { x: "a".repeat(33_000) };
    await expect(
      handleBroadcast({ channel: "c", event: "e", payload: huge }, { sender: { send } }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});
