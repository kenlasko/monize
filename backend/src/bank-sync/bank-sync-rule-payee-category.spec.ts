import { EntityManager, In } from "typeorm";
import { Payee } from "../payees/entities/payee.entity";
import type { RuleNetChanges } from "../transaction-rules/rule-effects";
import {
  loadPayeeDefaultCategories,
  payeeGivingDefaultCategory,
} from "./bank-sync-rule-payee-category";
import { USER_ID } from "./bank-sync-testing";

const changes = (over: Partial<RuleNetChanges> = {}): RuleNetChanges => ({
  addTagIds: [],
  removeTagIds: [],
  ...over,
});

describe("payeeGivingDefaultCategory", () => {
  it("is the payee a rule changed the row to, when no rule set a category", () => {
    expect(payeeGivingDefaultCategory(changes({ payeeId: "p-1" }))).toBe("p-1");
  });

  it("is none when a rule set or cleared the category: the rule wins", () => {
    expect(
      payeeGivingDefaultCategory(changes({ payeeId: "p-1", categoryId: "c" })),
    ).toBeNull();
    expect(
      payeeGivingDefaultCategory(changes({ payeeId: "p-1", categoryId: null })),
    ).toBeNull();
  });

  it("is none for a row a structural action made a split or a transfer", () => {
    expect(
      payeeGivingDefaultCategory(
        changes({
          payeeId: "p-1",
          structure: {} as RuleNetChanges["structure"],
        }),
      ),
    ).toBeNull();
  });

  it("is none when the rules cleared the payee, left it alone, or only planned a payee to create", () => {
    expect(payeeGivingDefaultCategory(changes({ payeeId: null }))).toBeNull();
    expect(payeeGivingDefaultCategory(changes())).toBeNull();
    expect(
      payeeGivingDefaultCategory(changes({ createPayee: "New shop" })),
    ).toBeNull();
  });
});

describe("loadPayeeDefaultCategories", () => {
  const repo = { find: jest.fn() };
  const m = {
    getRepository: jest.fn((entity: unknown) => {
      if (entity !== Payee) throw new Error("unexpected repository");
      return repo;
    }),
  } as unknown as EntityManager;

  beforeEach(() => jest.clearAllMocks());

  it("reads nothing for no payee", async () => {
    expect((await loadPayeeDefaultCategories(m, USER_ID, [])).size).toBe(0);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it("reads the user's payees once, each id once, and keeps those with a default category", async () => {
    repo.find.mockResolvedValue([
      {
        id: "p-1",
        defaultCategoryId: "c-1",
        defaultCategory: { id: "c-1", name: "Coffee" },
      },
      { id: "p-2", defaultCategoryId: null, defaultCategory: null },
    ]);

    const found = await loadPayeeDefaultCategories(m, USER_ID, [
      "p-1",
      "p-2",
      "p-1",
    ]);

    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(repo.find).toHaveBeenCalledWith({
      where: { id: In(["p-1", "p-2"]), userId: USER_ID },
      relations: { defaultCategory: true },
    });
    expect([...found.entries()]).toEqual([
      ["p-1", { categoryId: "c-1", categoryName: "Coffee" }],
    ]);
  });
});
