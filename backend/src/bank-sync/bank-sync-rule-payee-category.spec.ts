import { EntityManager, In } from "typeorm";
import { Payee } from "../payees/entities/payee.entity";
import type {
  RuleEffects,
  RuleNetChanges,
  RuleTraceEntry,
} from "../transaction-rules/rule-effects";
import {
  loadPayeeDefaultCategories,
  payeeGivingDefaultCategory,
} from "./bank-sync-rule-payee-category";
import { USER_ID } from "./bank-sync-testing";

/** A rule that matched and set the payee, plus `entry` for what else it did. */
const payeeRule = (entry: Partial<RuleTraceEntry> = {}): RuleTraceEntry => ({
  ruleId: "rule-1",
  matched: true,
  applied: [{ type: "set_payee" }],
  skipped: [],
  changes: { payeeId: { before: null, after: "p-1" } },
  stopped: false,
  ...entry,
});

const effects = (
  over: Partial<RuleNetChanges> = {},
  trace: RuleTraceEntry[] = [payeeRule()],
): Pick<RuleEffects, "changes" | "trace"> => ({
  changes: { addTagIds: [], removeTagIds: [], ...over },
  trace,
});

describe("payeeGivingDefaultCategory", () => {
  it("is the payee a rule changed the row to, when no rule set a category", () => {
    expect(payeeGivingDefaultCategory(effects({ payeeId: "p-1" }))).toBe("p-1");
  });

  it("is none when a rule set or cleared the category: the rule wins", () => {
    expect(
      payeeGivingDefaultCategory(effects({ payeeId: "p-1", categoryId: "c" })),
    ).toBeNull();
    expect(
      payeeGivingDefaultCategory(effects({ payeeId: "p-1", categoryId: null })),
    ).toBeNull();
  });

  it("is none when a rule's set_category confirmed the category the row already had", () => {
    // The net changes carry no categoryId: the action was a no-op.
    const trace = [
      payeeRule({
        applied: [{ type: "set_payee" }],
        skipped: [{ type: "set_category", reason: "no_change" }],
      }),
    ];
    expect(
      payeeGivingDefaultCategory(effects({ payeeId: "p-1" }, trace)),
    ).toBeNull();
  });

  it("is none when an onlyIfEmpty set_category kept the category the row held", () => {
    const trace = [
      payeeRule(),
      payeeRule({
        ruleId: "rule-2",
        applied: [],
        skipped: [{ type: "set_category", reason: "already_set" }],
        changes: {},
      }),
    ];
    expect(
      payeeGivingDefaultCategory(effects({ payeeId: "p-1" }, trace)),
    ).toBeNull();
  });

  it("is none when rules set a category and then set it back: a rule still chose it", () => {
    const trace = [
      payeeRule({ applied: [{ type: "set_payee" }, { type: "set_category" }] }),
      payeeRule({
        ruleId: "rule-2",
        applied: [{ type: "set_category" }],
        changes: {},
      }),
    ];
    expect(
      payeeGivingDefaultCategory(effects({ payeeId: "p-1" }, trace)),
    ).toBeNull();
  });

  it("still gives the payee's category when a set_category was refused for another reason", () => {
    const trace = [
      payeeRule({
        skipped: [{ type: "set_category", reason: "row_is_transfer_leg" }],
      }),
    ];
    expect(payeeGivingDefaultCategory(effects({ payeeId: "p-1" }, trace))).toBe(
      "p-1",
    );
  });

  it("is none for a row a structural action made a split or a transfer", () => {
    expect(
      payeeGivingDefaultCategory(
        effects({
          payeeId: "p-1",
          structure: {} as RuleNetChanges["structure"],
        }),
      ),
    ).toBeNull();
  });

  it("is none when the rules cleared the payee, left it alone, or only planned a payee to create", () => {
    expect(payeeGivingDefaultCategory(effects({ payeeId: null }))).toBeNull();
    expect(payeeGivingDefaultCategory(effects({}, []))).toBeNull();
    expect(
      payeeGivingDefaultCategory(effects({ createPayee: "New shop" })),
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
