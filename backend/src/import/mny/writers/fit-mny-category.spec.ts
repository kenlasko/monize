import { EntityManager } from "typeorm";
import { fitMnyCategory, transferCategoryIdsAmong } from "./fit-mny-category";

/** INV-CATEGORY-001 on the Money writers: a reused Transfer category stays off a category row. */
describe("fitMnyCategory", () => {
  const input = {
    categoryIdByHandle: new Map([
      [1, "cat-expense"],
      [2, "cat-transfer"],
    ]),
    transferCategoryIds: new Set(["cat-transfer"]),
  };

  it("writes the file's category where it fits, and none on a category row for a Transfer one", () => {
    expect(fitMnyCategory(input, 1, "category")).toBe("cat-expense");
    expect(fitMnyCategory(input, 1, "transfer")).toBe("cat-expense");
    expect(fitMnyCategory(input, 2, "transfer")).toBe("cat-transfer");
    expect(fitMnyCategory(input, 2, "category")).toBeNull();
  });

  it("writes none for no category or one the import did not map", () => {
    expect(fitMnyCategory(input, null, "category")).toBeNull();
    expect(fitMnyCategory(input, 9, "transfer")).toBeNull();
    // Without the Transfer ids (a caller of the previous shape) every mapped category is written.
    expect(
      fitMnyCategory(
        { categoryIdByHandle: input.categoryIdByHandle },
        2,
        "category",
      ),
    ).toBe("cat-transfer");
  });

  it("asks for the Transfer categories among the mapped ids once, and nothing for none", async () => {
    const query = jest.fn().mockResolvedValue([{ id: "cat-transfer" }]);
    const m = { query } as unknown as EntityManager;
    await expect(
      transferCategoryIdsAmong(m, "user-1", input.categoryIdByHandle),
    ).resolves.toEqual(new Set(["cat-transfer"]));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([
      "user-1",
      ["cat-expense", "cat-transfer"],
    ]);
    await expect(
      transferCategoryIdsAmong(m, "user-1", new Map()),
    ).resolves.toEqual(new Set());
    expect(query).toHaveBeenCalledTimes(1);
  });
});
