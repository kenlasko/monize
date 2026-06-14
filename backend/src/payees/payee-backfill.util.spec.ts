import { IsNull } from "typeorm";
import {
  applyPayeeCategoryToAll,
  backfillPayeeCategory,
  countUncategorizedTransactionsByPayee,
} from "./payee-backfill.util";
import { Transaction } from "../transactions/entities/transaction.entity";

const userId = "user-1";

describe("payee-backfill.util", () => {
  describe("countUncategorizedTransactionsByPayee", () => {
    function makeManager(rows: Array<{ payeeId: string; cnt: string }>): {
      manager: any;
      qb: Record<string, jest.Mock>;
    } {
      const qb: Record<string, jest.Mock> = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(rows),
      };
      const manager = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      return { manager, qb };
    }

    it("maps each payee id to its parsed count", async () => {
      const { manager } = makeManager([
        { payeeId: "p1", cnt: "4" },
        { payeeId: "p2", cnt: "1" },
      ]);

      const result = await countUncategorizedTransactionsByPayee(
        manager,
        userId,
      );

      expect(result.get("p1")).toBe(4);
      expect(result.get("p2")).toBe(1);
      expect(result.size).toBe(2);
    });

    it("returns an empty map when there are no uncategorized transactions", async () => {
      const { manager } = makeManager([]);

      const result = await countUncategorizedTransactionsByPayee(
        manager,
        userId,
      );

      expect(result.size).toBe(0);
    });

    it("filters by user, presence of payee, missing category, and excludes transfers/splits", async () => {
      const { manager, qb } = makeManager([]);

      await countUncategorizedTransactionsByPayee(manager, userId);

      expect(qb.where).toHaveBeenCalledWith("t.user_id = :userId", { userId });
      const andWhereClauses = qb.andWhere.mock.calls.map((c) => c[0]);
      expect(andWhereClauses).toEqual(
        expect.arrayContaining([
          "t.payee_id IS NOT NULL",
          "t.category_id IS NULL",
          "t.is_transfer = false",
          "t.is_split = false",
        ]),
      );
    });
  });

  describe("backfillPayeeCategory", () => {
    it("updates only the payee's uncategorized, non-transfer, non-split rows", async () => {
      const manager = {
        update: jest.fn().mockResolvedValue({ affected: 5 }),
      };

      const affected = await backfillPayeeCategory(
        manager as any,
        userId,
        "p1",
        "cat-1",
      );

      expect(affected).toBe(5);
      expect(manager.update).toHaveBeenCalledWith(
        Transaction,
        {
          userId,
          payeeId: "p1",
          categoryId: IsNull(),
          isTransfer: false,
          isSplit: false,
        },
        { categoryId: "cat-1" },
      );
    });

    it("returns 0 when the driver reports no affected count", async () => {
      const manager = { update: jest.fn().mockResolvedValue({}) };

      const affected = await backfillPayeeCategory(
        manager as any,
        userId,
        "p1",
        "cat-1",
      );

      expect(affected).toBe(0);
    });
  });

  describe("applyPayeeCategoryToAll", () => {
    it("updates all of the payee's non-transfer, non-split rows regardless of existing category", async () => {
      const manager = {
        update: jest.fn().mockResolvedValue({ affected: 8 }),
      };

      const affected = await applyPayeeCategoryToAll(
        manager as any,
        userId,
        "p1",
        "cat-1",
      );

      expect(affected).toBe(8);
      // No categoryId condition: rows that already have a category are
      // overwritten, unlike the uncategorized-only backfill.
      expect(manager.update).toHaveBeenCalledWith(
        Transaction,
        {
          userId,
          payeeId: "p1",
          isTransfer: false,
          isSplit: false,
        },
        { categoryId: "cat-1" },
      );
    });

    it("returns 0 when the driver reports no affected count", async () => {
      const manager = { update: jest.fn().mockResolvedValue({}) };

      const affected = await applyPayeeCategoryToAll(
        manager as any,
        userId,
        "p1",
        "cat-1",
      );

      expect(affected).toBe(0);
    });
  });
});
