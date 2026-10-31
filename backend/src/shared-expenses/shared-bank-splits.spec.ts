import { allocateBankSplits } from "./shared-bank-splits";
import type { SharedBankRow, SharedBankSplit } from "./shared-finance-types";
import { sharedBankFixture } from "./__fixtures__/shared-finance";

const split = (
  id: string,
  amount: string,
  patch: Partial<SharedBankSplit> = {},
): SharedBankSplit => ({
  id,
  amount,
  kind: "category",
  categoryId: id,
  memo: `Note ${id}`,
  createdAt: "2026-01-01T00:00:00Z",
  tagIds: ["tag"],
  transferAccountId: null,
  linkedTransactionId: null,
  investmentLinked: false,
  ...patch,
});
const bank = (patch: Partial<SharedBankRow> = {}): SharedBankRow => ({
  ...sharedBankFixture(),
  isSplit: true,
  amount: "-350.0000",
  splits: [split("food", "-300.0000"), split("private", "-50.0000")],
  ...patch,
});

describe("Selecting category split portions for a shared payment", () => {
  it("keeps the private remainder's identity, categories, notes and tags", () => {
    const source = bank();
    expect(
      allocateBankSplits(source, [{ splitId: "food", amount: "240" }]),
    ).toEqual({
      sharedAmount: "-240.0000",
      privateSplits: [
        { ...source.splits![0], amount: "-60.0000" },
        source.splits![1],
      ],
    });
    expect(source.splits![0].amount).toBe("-300.0000");
  });
  it("consumes a whole line while preserving other lines", () => {
    const source = bank();
    expect(
      allocateBankSplits(source, [{ splitId: "food", amount: "300" }]),
    ).toEqual({
      sharedAmount: "-300.0000",
      privateSplits: [source.splits![1]],
    });
  });
  it("supports incoming money and four-decimal portions without floating point accumulation", () => {
    expect(
      allocateBankSplits(
        bank({
          amount: "1.0000",
          splits: [split("a", "0.3333"), split("b", "0.6667")],
        }),
        [
          { splitId: "a", amount: "0.3333" },
          { splitId: "b", amount: "0.6667" },
        ],
      ),
    ).toEqual({
      sharedAmount: "1.0000",
      privateSplits: [],
    });
  });
  it("preserves offsetting private lines even when their net remainder is zero", () => {
    const source = bank({
      amount: "-100.0000",
      splits: [
        split("a", "-100.0000"),
        split("b", "-20.0000"),
        split("discount", "20.0000"),
      ],
    });
    expect(
      allocateBankSplits(source, [{ splitId: "a", amount: "100" }])
        ?.privateSplits,
    ).toEqual(source.splits!.slice(1));
  });
  it.each([
    undefined,
    [],
    [{ splitId: "missing", amount: "10" }],
    [{ splitId: "food", amount: "301" }],
    [{ splitId: "food", amount: "0" }],
    [
      { splitId: "food", amount: "1" },
      { splitId: "food", amount: "2" },
    ],
  ])(
    "refuses an absent, invalid or repeated selection before producing a plan: %j",
    (selection) => {
      expect(() => allocateBankSplits(bank(), selection)).toThrow();
    },
  );
  it.each([
    { kind: "transfer" },
    { kind: "investment" },
    { transferAccountId: "other" },
    { linkedTransactionId: "other" },
    { investmentLinked: true },
    { amount: "-299" },
  ])("refuses structural or inconsistent source rows: %j", (patch) => {
    expect(() =>
      allocateBankSplits(
        bank({
          splits: [split("food", "-300", patch), split("private", "-50")],
        }),
        [{ splitId: "food", amount: "10" }],
      ),
    ).toThrow();
  });
  it("refuses allocating a positive refund line to an outgoing payment", () => {
    expect(() =>
      allocateBankSplits(
        bank({
          amount: "-300",
          splits: [split("food", "-350"), split("discount", "50")],
        }),
        [{ splitId: "discount", amount: "10" }],
      ),
    ).toThrow();
  });
  it("leaves plain movements to the ordinary planner and refuses split input on them", () => {
    expect(allocateBankSplits(bank({ isSplit: false }), undefined)).toBeNull();
    expect(() =>
      allocateBankSplits(bank({ isSplit: false }), [
        { splitId: "food", amount: "1" },
      ]),
    ).toThrow();
  });
});
