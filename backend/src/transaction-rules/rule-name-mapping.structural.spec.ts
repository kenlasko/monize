import { RuleAction } from "./rule-action.types";
import { RuleDefinitionLabels } from "./rule-labels";
import {
  NameLookup,
  collectNamedReferences,
  idsToNames,
  namesToIds,
} from "./rule-name-mapping";

const LOAN = "a0000000-0000-4000-8000-000000000001";
const SAVINGS = "a0000000-0000-4000-8000-000000000002";
const REPAYMENT = "b0000000-0000-4000-8000-000000000001";
const OVERPAYMENT = "b0000000-0000-4000-8000-000000000002";
const INTEREST = "c0000000-0000-4000-8000-000000000001";

const IDS: Record<string, string> = {
  "Loan account": LOAN,
  Savings: SAVINGS,
  "Loan repayment": REPAYMENT,
  "Loan overpayment": OVERPAYMENT,
  "Loans: Interest": INTEREST,
};
const lookup: NameLookup = (_kind, name) =>
  IDS[name] ? { id: IDS[name] } : { failure: "NAME_NOT_FOUND" };

const LABELS: RuleDefinitionLabels = {
  accounts: { [LOAN]: "Loan account", [SAVINGS]: "Savings" },
  payees: { [REPAYMENT]: "Loan repayment", [OVERPAYMENT]: "Loan overpayment" },
  categories: { [INTEREST]: "Loans: Interest" },
  tags: {},
};

const namedConvert = {
  type: "convert_to_transfer",
  toAccountName: "Loan account",
  clearCategory: true,
  payeeName: "Loan repayment",
};
const storedConvert = {
  type: "convert_to_transfer",
  toAccountId: LOAN,
  clearCategory: true,
  payeeId: REPAYMENT,
};
const namedSplit = {
  type: "split",
  payeeName: "Loan repayment",
  parts: [
    {
      amount: "{principal}",
      transferTo: "Loan account",
      payeeName: "Loan overpayment",
    },
    {
      amount: "{interest}",
      categoryName: "Loans: Interest",
      description: "interest",
    },
    { amount: "rest" },
  ],
};
const storedSplit = {
  type: "split",
  payeeId: REPAYMENT,
  parts: [
    { amount: "{principal}", transferAccountId: LOAN, payeeId: OVERPAYMENT },
    { amount: "{interest}", categoryId: INTEREST, description: "interest" },
    { amount: "rest" },
  ],
};

describe("structural actions in the name form", () => {
  it("collects the names of both actions, every part included", () => {
    expect(
      collectNamedReferences({ all: [] }, [
        namedConvert,
        {
          ...namedConvert,
          fromAccountName: "Savings",
          toAccountName: undefined,
        },
        namedSplit,
      ]),
    ).toEqual({
      accounts: ["Loan account", "Savings"],
      payees: ["Loan repayment", "Loan overpayment"],
      categories: ["Loans: Interest"],
      tags: [],
    });
  });

  it("turns names into ids for convert_to_transfer", () => {
    const mapped = namesToIds({ all: [] }, [namedConvert], lookup);
    expect(mapped.errors).toEqual([]);
    expect(mapped.actions).toEqual([storedConvert]);
  });

  it("turns fromAccountName into fromAccountId", () => {
    const mapped = namesToIds(
      { all: [] },
      [{ type: "convert_to_transfer", fromAccountName: "Savings" }],
      lookup,
    );
    expect(mapped.actions).toEqual([
      { type: "convert_to_transfer", fromAccountId: SAVINGS },
    ]);
  });

  it("turns names into ids for split and every part", () => {
    const mapped = namesToIds({ all: [] }, [namedSplit], lookup);
    expect(mapped.errors).toEqual([]);
    expect(mapped.actions).toEqual([storedSplit]);
  });

  it("reports a name that does not resolve at the path of its key", () => {
    const mapped = namesToIds(
      { all: [] },
      [
        { ...namedConvert, toAccountName: "Nowhere" },
        {
          type: "split",
          parts: [
            { amount: "{a}", transferTo: "Nowhere", payeeName: "Nobody" },
            { amount: "rest", categoryName: "Nothing" },
          ],
        },
      ],
      lookup,
    );
    expect(mapped.errors.map((e) => [e.path, e.kind, e.name])).toEqual([
      ["actions[0].toAccountName", "accounts", "Nowhere"],
      ["actions[1].parts[0].transferTo", "accounts", "Nowhere"],
      ["actions[1].parts[0].payeeName", "payees", "Nobody"],
      ["actions[1].parts[1].categoryName", "categories", "Nothing"],
    ]);
  });

  it("leaves a part that is not an object, and a split without parts, to the validator", () => {
    const mapped = namesToIds(
      { all: [] },
      [{ type: "split", parts: ["x", 4, null] }, { type: "split" }],
      lookup,
    );
    expect(mapped.errors).toEqual([]);
    expect(mapped.actions).toEqual([
      { type: "split", parts: ["x", 4, null] },
      { type: "split" },
    ]);
  });

  it("does not read names beyond the validator's part limit", () => {
    const parts = Array.from({ length: 12 }, () => ({
      amount: "rest",
      transferTo: "Loan account",
    }));
    expect(
      collectNamedReferences({ all: [] }, [{ type: "split", parts }]).accounts,
    ).toEqual(["Loan account"]);
    const mapped = namesToIds({ all: [] }, [{ type: "split", parts }], lookup);
    const out = (mapped.actions as { parts: Record<string, unknown>[] }[])[0]
      .parts;
    expect(out).toHaveLength(12);
    expect(out[9].transferAccountId).toBe(LOAN);
    expect(out[10].transferTo).toBe("Loan account");
  });

  it("round trips both actions: ids to names and back", () => {
    const named = idsToNames(
      {
        condition: { all: [] },
        actions: [storedConvert, storedSplit] as unknown as RuleAction[],
      },
      LABELS,
    );
    expect(named.actions).toEqual([namedConvert, namedSplit]);
    const back = namesToIds(named.condition, named.actions, lookup);
    expect(back.errors).toEqual([]);
    expect(back.actions).toEqual([storedConvert, storedSplit]);
  });

  it("names a fromAccountId and keeps the id of an account that is gone", () => {
    const named = idsToNames(
      {
        condition: { all: [] },
        actions: [
          {
            type: "convert_to_transfer",
            fromAccountId: SAVINGS,
            clearCategory: false,
          },
          {
            type: "split",
            parts: [
              { amount: "rest", transferAccountId: "gone" },
              { amount: "rest" },
            ],
          },
        ] as unknown as RuleAction[],
      },
      LABELS,
    );
    expect(named.actions).toEqual([
      {
        type: "convert_to_transfer",
        fromAccountName: "Savings",
        clearCategory: false,
      },
      {
        type: "split",
        parts: [{ amount: "rest", transferTo: "gone" }, { amount: "rest" }],
      },
    ]);
  });
});
