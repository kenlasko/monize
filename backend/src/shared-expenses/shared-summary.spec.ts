import { summarizeSharedPositions } from "./shared-summary";

describe("shared group summary", () => {
  const group = (
    id: string,
    balance: string | null,
    currencyCode = "PLN",
    knownBalance = "0.0000",
  ) => ({
    id,
    currencyCode,
    archivedAt: null,
    myPosition: { balance, knownBalance },
  });
  it("keeps claims and debts separate within each currency, including zero and four-place pennies", () => {
    expect(
      summarizeSharedPositions([
        group("a", "100.0001"),
        group("b", "-100.0000"),
        group("c", "0.0001"),
        group("d", "0.0000", "EUR"),
      ]),
    ).toEqual([
      {
        currencyCode: "EUR",
        receivable: "0.0000",
        payable: "0.0000",
        knownReceivable: "0.0000",
        knownPayable: "0.0000",
        unresolvedGroupIds: [],
      },
      {
        currencyCode: "PLN",
        receivable: "100.0002",
        payable: "100.0000",
        knownReceivable: "100.0002",
        knownPayable: "100.0000",
        unresolvedGroupIds: [],
      },
    ]);
  });
  it("keeps archived debts in the summary and withholds totals when missing FX could change the sign", () => {
    expect(
      summarizeSharedPositions([
        group("a", null, "PLN", "12.0000"),
        group("b", "-5.0000"),
        { ...group("archived", "900.0000"), archivedAt: "2026-01-01" },
      ]),
    ).toEqual([
      {
        currencyCode: "PLN",
        receivable: null,
        payable: null,
        knownReceivable: "912.0000",
        knownPayable: "5.0000",
        unresolvedGroupIds: ["a"],
      },
    ]);
  });
});
