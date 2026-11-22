import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertSecuritiesActiveIn,
  assertSecurityActive,
} from "./inactive-security.util";

describe("inactive-security.util (#2323)", () => {
  const userId = "user-1";

  const managerAnswering = (
    rows: Array<{ symbol: string; is_active: boolean | null }>,
  ) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { manager: { query } as unknown as EntityManager, query };
  };

  describe("assertSecuritiesActiveIn", () => {
    it("asks nothing when no security is named", async () => {
      const { manager, query } = managerAnswering([]);

      await assertSecuritiesActiveIn(manager, userId, [null, undefined]);

      expect(query).not.toHaveBeenCalled();
    });

    it("reads each named security once, the caller's own, FOR KEY SHARE", async () => {
      const { manager, query } = managerAnswering([
        { symbol: "AAPL", is_active: true },
      ]);

      await assertSecuritiesActiveIn(manager, userId, [
        "sec-b",
        null,
        "sec-a",
        "sec-b",
      ]);

      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain("FOR KEY SHARE");
      expect(sql).toContain("user_id = $2");
      expect(params).toEqual([["sec-a", "sec-b"], userId]);
    });

    it("refuses with a 409 naming the deactivated security", async () => {
      const { manager } = managerAnswering([
        { symbol: "AAPL", is_active: true },
        { symbol: "VFIAX", is_active: false },
      ]);

      const refusal = assertSecuritiesActiveIn(manager, userId, ["a", "b"]);

      await expect(refusal).rejects.toBeInstanceOf(ConflictException);
      await expect(
        assertSecuritiesActiveIn(manager, userId, ["a", "b"]),
      ).rejects.toThrow(/VFIAX is deactivated.*Activate VFIAX/);
    });

    it("treats a NULL is_active as active, as the column default does", async () => {
      const { manager } = managerAnswering([
        { symbol: "AAPL", is_active: null },
      ]);

      await expect(
        assertSecuritiesActiveIn(manager, userId, ["a"]),
      ).resolves.toBeUndefined();
    });
  });

  describe("assertSecurityActive", () => {
    it("passes an active security", () => {
      expect(() =>
        assertSecurityActive({ symbol: "AAPL", isActive: true }),
      ).not.toThrow();
    });

    it("refuses a deactivated one with the same message", () => {
      expect(() =>
        assertSecurityActive({ symbol: "AAPL", isActive: false }),
      ).toThrow(/AAPL is deactivated/);
    });
  });
});
