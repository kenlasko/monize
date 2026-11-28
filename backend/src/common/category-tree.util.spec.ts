import { Repository } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "./category-tree.util";

type Row = Pick<Category, "id" | "parentId" | "categoryType">;

const rows: Row[] = [
  { id: "salary", parentId: null, categoryType: "income" },
  { id: "bonus", parentId: "salary", categoryType: "income" },
  { id: "food", parentId: null, categoryType: "expense" },
  { id: "groceries", parentId: "food", categoryType: "expense" },
  { id: "rent", parentId: null, categoryType: "expense" },
];

function repo(data: Row[] = rows): Repository<Category> {
  return {
    find: jest.fn().mockResolvedValue(data),
  } as unknown as Repository<Category>;
}

describe("getAllCategoryIdsWithChildren", () => {
  it("expands a parent id to its descendants", async () => {
    const ids = await getAllCategoryIdsWithChildren(repo(), "u1", ["food"]);
    expect(ids.sort()).toEqual(["food", "groceries"]);
  });

  it("selects every category of a type for the 'income' pseudo-id", async () => {
    const ids = await getAllCategoryIdsWithChildren(repo(), "u1", ["income"]);
    expect(ids.sort()).toEqual(["bonus", "salary"]);
  });

  it("selects every category of a type for the 'expense' pseudo-id", async () => {
    const ids = await getAllCategoryIdsWithChildren(repo(), "u1", ["expense"]);
    expect(ids.sort()).toEqual(["food", "groceries", "rent"]);
  });

  it("unions a type pseudo-id with explicit ids without duplicates", async () => {
    const ids = await getAllCategoryIdsWithChildren(repo(), "u1", [
      "income",
      "salary",
      "rent",
    ]);
    expect(ids.sort()).toEqual(["bonus", "rent", "salary"]);
  });

  it("resolves a type with no categories to nothing", async () => {
    const onlyExpenses = rows.filter((r) => r.categoryType === "expense");
    const ids = await getAllCategoryIdsWithChildren(repo(onlyExpenses), "u1", [
      "income",
    ]);
    expect(ids).toEqual([]);
  });

  it("scopes the lookup to the user", async () => {
    const r = repo();
    await getAllCategoryIdsWithChildren(r, "u1", ["food"]);
    expect(r.find).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: ["id", "parentId", "categoryType"],
    });
  });
});
