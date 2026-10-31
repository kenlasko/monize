import { BalanceEntry, sharedBalances } from "./shared-balances";
import { fixedUnits } from "./shared-money";

const people = ["me", "anna", "bartek"];
const expense: BalanceEntry = {
  type: "EXPENSE",
  amount: "300.0000",
  contributions: [{ participantId: "me", amount: "300.0000" }],
  shares: people.map((participantId) => ({
    participantId,
    amount: "100.0000",
  })),
};

describe("shared journal balances (SE-001, SE-005, SE-007)", () => {
  it("distinguishes paid, own cost and receivable", () => {
    const result = sharedBalances(people, [expense]);
    expect(result.positions[0]).toMatchObject({
      paid: "300.0000",
      cost: "100.0000",
      balance: "200.0000",
    });
    expect(result.suggestions).toEqual([
      { fromParticipantId: "anna", toParticipantId: "me", amount: "100.0000" },
      {
        fromParticipantId: "bartek",
        toParticipantId: "me",
        amount: "100.0000",
      },
    ]);
  });

  it("partial repayment reduces debt without changing cost or income", () => {
    const result = sharedBalances(people, [
      expense,
      {
        type: "REPAYMENT",
        amount: "40.0000",
        shares: [],
        contributions: [],
        fromParticipantId: "anna",
        toParticipantId: "me",
      },
    ]);
    expect(result.positions.map((row) => row.balance)).toEqual([
      "160.0000",
      "-60.0000",
      "-100.0000",
    ]);
    expect(result.totalExpenses).toBe("300.0000");
    expect(result.totalIncome).toBe("0.0000");
  });

  it("refunds reverse expense shares and reopen a fully settled group", () => {
    const payments: BalanceEntry[] = people
      .slice(1)
      .map((fromParticipantId) => ({
        type: "REPAYMENT",
        amount: "100.0000",
        shares: [],
        contributions: [],
        fromParticipantId,
        toParticipantId: "me",
      }));
    const result = sharedBalances(people, [
      expense,
      ...payments,
      {
        type: "REFUND",
        amount: "60.0000",
        contributions: [{ participantId: "me", amount: "60.0000" }],
        shares: people.map((participantId) => ({
          participantId,
          amount: "20.0000",
        })),
      },
    ]);
    expect(result.totalExpenses).toBe("240.0000");
    expect(result.positions.map((row) => row.balance)).toEqual([
      "-40.0000",
      "20.0000",
      "20.0000",
    ]);
  });

  it("income is separated from expense refunds", () => {
    const result = sharedBalances(people, [
      {
        type: "INCOME",
        amount: "90.0000",
        contributions: [{ participantId: "me", amount: "90.0000" }],
        shares: people.map((participantId) => ({
          participantId,
          amount: "30.0000",
        })),
      },
    ]);
    expect(result.totalExpenses).toBe("0.0000");
    expect(result.totalIncome).toBe("90.0000");
    expect(result.positions.map((row) => row.balance)).toEqual([
      "-60.0000",
      "30.0000",
      "30.0000",
    ]);
  });

  it("does not label a known subtotal as a total when one rate is missing", () => {
    const result = sharedBalances(people, [
      expense,
      { ...expense, amount: null },
    ]);
    expect(result).toMatchObject({
      settlementReady: false,
      totalExpenses: null,
      knownExpenses: "300.0000",
      totalIncome: null,
      suggestions: [],
    });
    expect(result.positions[0]).toMatchObject({
      balance: null,
      knownBalance: "200.0000",
    });
  });

  it("an empty group is a known zero", () => {
    expect(sharedBalances(people, [])).toMatchObject({
      settlementReady: true,
      totalExpenses: "0.0000",
      totalIncome: "0.0000",
      suggestions: [],
    });
  });

  it("several payers with uneven shares conserve zero and net transfers", () => {
    const result = sharedBalances(people, [
      {
        ...expense,
        contributions: [
          { participantId: "me", amount: "200.0000" },
          { participantId: "anna", amount: "100.0000" },
        ],
        shares: people.map((participantId, i) => ({
          participantId,
          amount: i === 0 ? "80.0000" : "110.0000",
        })),
      },
    ]);
    expect(result.positions.map((row) => row.balance)).toEqual([
      "120.0000",
      "-10.0000",
      "-110.0000",
    ]);
    expect(
      result.positions.reduce(
        (sum, row) => sum + fixedUnits(row.balance!, 4, true),
        0n,
      ),
    ).toBe(0n);
    expect(result.suggestions).toHaveLength(2);
  });

  it("refuses an unbalanced journal instead of proposing misleading payments", () => {
    expect(() =>
      sharedBalances(people, [{ ...expense, contributions: [] }]),
    ).toThrow("do not sum to zero");
  });
});
