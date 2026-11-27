import { EntityManager } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import {
  fitOverrideCategories,
  lockOverrideCategoryOwner,
} from "./scheduled-category-fit";

/**
 * INV-CATEGORY-001 on an override, and the lock order of `common/db/locks.ts`:
 * the shared category-owner lock before the schedule's row lock.
 */
describe("fitOverrideCategories", () => {
  const harness = (schedule: { isTransfer: boolean }) => {
    const order: string[] = [];
    const scheduleRepo = {
      findOne: jest.fn(async (options: { lock?: unknown }) => {
        order.push(options.lock ? "schedule share lock" : "schedule owner");
        return { id: "sched-1", userId: "user-1", ...schedule };
      }),
    };
    const categoryRepo = {
      findOne: jest.fn(async () => ({
        id: "cat-1",
        name: "Groceries",
        categoryType: "expense",
      })),
    };
    const m = {
      getRepository: (entity: unknown) =>
        entity === Category ? categoryRepo : scheduleRepo,
      query: jest.fn(async (sql: string) => {
        if (sql.includes("pg_advisory_xact_lock_shared")) {
          order.push("category-owner lock");
        }
        return [];
      }),
      find: jest.fn(async () => []),
    } as unknown as EntityManager;
    return { m, order };
  };

  it("locks the category owner, read without a row lock, when a category is named", async () => {
    const { m, order } = harness({ isTransfer: false });
    await lockOverrideCategoryOwner(m, "sched-1", { categoryId: "cat-1" });
    expect(order).toEqual(["schedule owner", "category-owner lock"]);
  });

  it("locks nothing when the override names no category", async () => {
    const { m, order } = harness({ isTransfer: false });
    await lockOverrideCategoryOwner(m, "sched-1", {
      categoryId: null,
      splits: [{ categoryId: "stale", investment: {} }],
    });
    expect(order).toEqual([]);
  });

  it("refuses a Transfer category on a scheduled ordinary transaction's override", async () => {
    const { m } = harness({ isTransfer: false });
    (
      m.getRepository(Category) as unknown as { findOne: jest.Mock }
    ).findOne.mockResolvedValue({
      id: "cat-t",
      name: "Savings",
      categoryType: "transfer",
    });
    await expect(
      fitOverrideCategories(m, "sched-1", { categoryId: "cat-t" }),
    ).rejects.toThrow(/Transfer category/);
  });
});
