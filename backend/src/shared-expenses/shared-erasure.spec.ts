import { EntityManager } from "typeorm";
import {
  assertSharedOwnershipTransferred,
  detachSharedLedgerForErasure,
  eraseSharedUser,
} from "./shared-erasure";
import { lockSharedGroup } from "./shared-db";

jest.mock("./shared-db", () => ({ lockSharedGroup: jest.fn() }));

describe("Shared erasure preconditions and private bridge cleanup", () => {
  let query: jest.Mock;
  let manager: EntityManager;
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    manager = { query } as unknown as EntityManager;
  });
  it("refuses owner erasure while another member or private integration remains", async () => {
    query
      .mockResolvedValueOnce([{ id: "first" }, { id: "second" }])
      .mockResolvedValueOnce([{ id: "second" }]);
    await expect(eraseSharedUser(manager, "owner")).rejects.toThrow();
    expect(lockSharedGroup).toHaveBeenNthCalledWith(1, manager, "first");
    expect(lockSharedGroup).toHaveBeenNthCalledWith(2, manager, "second");
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(
      true,
    );
  });
  it("permits solo ownership after the locked recheck", async () => {
    query.mockResolvedValueOnce([{ id: "solo" }]).mockResolvedValueOnce([]);
    await expect(
      assertSharedOwnershipTransferred(manager, "owner"),
    ).resolves.toBeUndefined();
    expect(query.mock.calls[1][0]).toContain("shared_integrations");
    expect(query.mock.calls[1][1]).toEqual(["owner"]);
  });
  it("detaches only the erased person's links and marks each private write with its posting", async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT group_id")) return [{ group_id: "group" }];
      if (sql.startsWith("SELECT id FROM shared_postings"))
        return [{ id: "posting" }];
      return [];
    });
    await detachSharedLedgerForErasure(manager, "owner");
    expect(query).toHaveBeenCalledWith(
      "SELECT set_config('app.shared_posting_id', $1, true)",
      ["posting"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "DELETE FROM shared_ledger_links WHERE user_id = $1",
      ),
      ["owner", "posting"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining(
        "UPDATE transactions SET shared_expense_posting_id = NULL WHERE user_id = $1",
      ),
      ["owner", "posting"],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE accounts SET managed_purpose = NULL"),
      ["owner", "group"],
    );
    expect(query).toHaveBeenLastCalledWith(
      "SELECT set_config('app.shared_group_id', '', true)",
    );
    expect(
      query.mock.calls.filter(([sql]) =>
        sql.startsWith("DELETE FROM shared_entries"),
      ),
    ).toEqual([]);
  });
  it("retains published documents under the remaining group owner before removing membership", async () => {
    await eraseSharedUser(manager, "owner");
    const mutations = query.mock.calls.filter(([sql]) =>
      /^(UPDATE|DELETE)/.test(sql),
    );
    const retain = mutations.findIndex(([sql]) =>
      sql.includes("UPDATE transaction_attachments"),
    );
    const member = mutations.findIndex(([sql]) =>
      sql.includes("DELETE FROM shared_memberships"),
    );
    expect(retain).toBeGreaterThanOrEqual(0);
    expect(member).toBeGreaterThan(retain);
    expect(mutations[retain][0]).toContain("g.owner_user_id <> $1");
    expect(mutations[retain][0]).toContain("upload_request_id = NULL");
    expect(mutations.every(([, args]) => args[0] === "owner")).toBe(true);
  });
});
