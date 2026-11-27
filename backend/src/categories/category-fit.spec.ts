import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import {
  assertCategoriesTakeCategoryRows,
  assertCategoryTakesCategoryRow,
  categoryFits,
  fitCategories,
  fitCategory,
  holderOfRow,
  holderOfSplitLine,
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

  it("accepts Income, Expense and none", async () => {
    categories.findOne.mockResolvedValueOnce({
      id: "c1",
      categoryType: "income",
    });
    await assertCategoryTakesCategoryRow(m, "user-1", "c1");
    categories.findOne.mockResolvedValueOnce({
      id: "c2",
      categoryType: "expense",
    });
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

describe("the fit helper (INV-CATEGORY-001)", () => {
  let categories: { find: jest.Mock; findOne: jest.Mock };
  let query: jest.Mock;
  let m: EntityManager;
  const savings = {
    id: "t1",
    name: "Savings",
    categoryType: "transfer" as const,
  };
  const food = { id: "e1", name: "Food", categoryType: "expense" as const };
  const salary = { id: "i1", name: "Salary", categoryType: "income" as const };

  beforeEach(() => {
    categories = { find: jest.fn(), findOne: jest.fn() };
    query = jest.fn().mockResolvedValue([]);
    m = {
      query,
      getRepository: jest.fn().mockReturnValue(categories),
      find: (_entity: unknown, options: unknown) => categories.find(options),
    } as unknown as EntityManager;
  });

  describe("categoryFits, the fit table of section 3", () => {
    it.each([
      [savings, "transfer", true],
      [food, "transfer", true],
      [salary, "transfer", true],
      [savings, "category", false],
      [food, "category", true],
      [salary, "category", true],
    ] as const)("%o on a %s row: %s", (category, holder, fits) => {
      expect(categoryFits(category, holder)).toBe(fits);
    });
  });

  it("reads a row's holder from its kind", () => {
    expect(holderOfRow({ isTransfer: true })).toBe("transfer");
    expect(holderOfRow({ isTransfer: false })).toBe("category");
    expect(holderOfRow({ isTransfer: null })).toBe("category");
    expect(holderOfSplitLine({ transferAccountId: "a2" })).toBe("transfer");
    expect(holderOfSplitLine({ transferAccountId: null })).toBe("category");
    expect(holderOfSplitLine({})).toBe("category");
  });

  it("on a category row takes the shared owner lock, then returns the category that fits", async () => {
    categories.findOne.mockImplementation(async () => {
      expect(query).toHaveBeenCalledWith(
        "SELECT pg_advisory_xact_lock_shared($1::int, hashtext($2))",
        [10, "user-1"],
      );
      return food;
    });

    await expect(fitCategory(m, "user-1", "e1", "category")).resolves.toBe(
      food,
    );
    expect(categories.findOne).toHaveBeenCalledWith({
      where: { id: "e1", userId: "user-1" },
    });
  });

  it("on a transfer row takes any type and no lock", async () => {
    categories.findOne.mockResolvedValue(savings);
    await expect(fitCategory(m, "user-1", "t1", "transfer")).resolves.toBe(
      savings,
    );
    categories.find.mockResolvedValue([savings]);
    await fitCategories(m, "user-1", [
      { categoryId: "t1", holder: "transfer" },
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses a Transfer category on a category row, naming it", async () => {
    categories.findOne.mockResolvedValue(savings);

    const refusal = fitCategory(m, "user-1", "t1", "category");
    await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
    await expect(refusal).rejects.toThrow(/Transfer category/);
  });

  it("refuses a category the person does not own, with the caller's error", async () => {
    categories.findOne.mockResolvedValue(null);

    await expect(
      fitCategory(m, "user-1", "x", "category"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      fitCategory(m, "user-1", "x", "transfer", {
        notFound: () => new BadRequestException("nope"),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("asks nothing for no category", async () => {
    await expect(fitCategory(m, "user-1", null, "category")).resolves.toBe(
      null,
    );
    await expect(
      fitCategories(m, "user-1", [{ categoryId: "", holder: "category" }]),
    ).resolves.toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it("reads many lines once and refuses the line that does not fit", async () => {
    categories.find.mockResolvedValue([food, savings]);

    const lines = [
      { categoryId: "e1", holder: "category" as const },
      { categoryId: "t1", holder: "transfer" as const },
    ];
    const found = await fitCategories(m, "user-1", lines);
    expect([...found.keys()].sort()).toEqual(["e1", "t1"]);
    expect(categories.find).toHaveBeenCalledTimes(1);

    await expect(
      fitCategories(m, "user-1", [
        ...lines,
        { categoryId: "t1", holder: "category" },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("names the categories the person does not own", async () => {
    categories.find.mockResolvedValue([food]);

    await expect(
      fitCategories(m, "user-1", [
        { categoryId: "e1", holder: "category" },
        { categoryId: "zz", holder: "transfer" },
      ]),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      fitCategories(m, "user-1", [{ categoryId: "zz", holder: "transfer" }], {
        notFound: (ids) => new BadRequestException(ids.join()),
      }),
    ).rejects.toMatchObject({ message: "zz" });
  });
});
