import { describe, expect, it } from "vitest";
import { handleDescribeTable } from "../../src/server/describe-table.ts";

describe("handleDescribeTable", () => {
  it("composes columns + RLS + replication-identity", async () => {
    const result = await handleDescribeTable(
      { table: "support_tickets" },
      {
        introspect: async () => ({
          schema: "public",
          columns: [
            { name: "id", type: "uuid", nullable: false, generated: false },
            { name: "subject", type: "text", nullable: false, generated: false },
            { name: "embedding", type: "halfvec", nullable: true, generated: false },
          ],
          primary_key: ["id"],
          rls_enabled: true,
          replication_identity: "full",
        }),
      },
    );
    expect(result).toEqual({
      table: "support_tickets",
      schema: "public",
      columns: expect.any(Array),
      primary_key: ["id"],
      rls_enabled: true,
      replication_identity: "full",
    });
    expect(result.columns).toHaveLength(3);
  });

  it("throws INVALID_TABLE when introspect returns null", async () => {
    await expect(
      handleDescribeTable({ table: "nope" }, { introspect: async () => null }),
    ).rejects.toMatchObject({ code: "INVALID_TABLE" });
  });
});
