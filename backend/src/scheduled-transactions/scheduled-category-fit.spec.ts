import { EntityManager } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { fitOverrideCategories } from "./scheduled-category-fit";

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

  it("takes the category-owner lock before the schedule's share lock when a category is named", async () => {
    const { m, order } = harness({ isTransfer: false });
    await fitOverrideCategories(m, "sched-1", { categoryId: "cat-1" });
    expect(order.slice(0, 3)).toEqual([
      "schedule owner",
      "category-owner lock",
      "schedule share lock",
    ]);
  });

  it("takes no category-owner lock when the override names no category", async () => {
    const { m, order } = harness({ isTransfer: false });
    await fitOverrideCategories(m, "sched-1", { categoryId: null });
    expect(order).toEqual(["schedule share lock"]);
  });
});
