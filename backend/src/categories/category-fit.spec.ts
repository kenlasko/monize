import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertCategoriesTakeCategoryRows,
  assertCategoryTakesCategoryRow,
} from "./category-fit";

describe("category fit refusals", () => {
  let categories: { find: jest.Mock; findOne: jest.Mock };
  let query: jest.Mock;
  let m: EntityManager;

  beforeEach(() => {
    categories = { find: jest.fn(), findOne: jest.fn() };
    query = jest.fn().mockResolvedValue([]);
    m = {
      query,
      getRepository: jest.fn().mockReturnValue(categories),
    } as unknown as EntityManager;
  });

  it("takes the shared category-owner lock before it reads the type", async () => {
    categories.findOne.mockImplementation(async () => {
      expect(query).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock_shared($1::int, hashtext($2))",
        [10, "user-1"],
      );
      return { id: "c1", name: "Food", categoryType: "expense" };
    });

    await assertCategoryTakesCategoryRow(m, "user-1", "c1");

    expect(categories.findOne).toHaveBeenCalledTimes(1);
  });

  it("refuses a Transfer category, naming it", async () => {
    categories.findOne.mockResolvedValue({
      id: "c1",
      name: "Savings",
      categoryType: "transfer",
    });

    await expect(
      assertCategoryTakesCategoryRow(m, "user-1", "c1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts Income, Expense, a category of the previous shape and none", async () => {
    categories.findOne.mockResolvedValueOnce({
      id: "c1",
      categoryType: "income",
    });
    await assertCategoryTakesCategoryRow(m, "user-1", "c1");
    // A value built before the type existed: only the legacy flag.
    categories.findOne.mockResolvedValueOnce({ id: "c2", isIncome: false });
    await assertCategoryTakesCategoryRow(m, "user-1", "c2");
    await assertCategoryTakesCategoryRow(m, "user-1", null);
    await assertCategoriesTakeCategoryRows(m, "user-1", [undefined, null]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("refuses when any of several categories is a Transfer category", async () => {
    categories.find.mockResolvedValue([
      { id: "c1", name: "Food", categoryType: "expense" },
      { id: "c2", name: "Savings", categoryType: "transfer" },
    ]);

    await expect(
      assertCategoriesTakeCategoryRows(m, "user-1", ["c1", "c2", "c1"]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
