import { applyDateRange, TableMap } from "./support-backup-scope";

describe("applyDateRange opening-balance shift", () => {
  const tables = (): TableMap => ({
    currencies: [
      { code: "CAD", decimal_places: 2 },
      { code: "BTC", decimal_places: 8 },
    ],
    accounts: [
      { id: "cad", currency_code: "CAD", opening_balance: 100.5 },
      { id: "btc", currency_code: "BTC", opening_balance: 0.00000001 },
    ],
    transactions: [
      {
        id: "t1",
        account_id: "cad",
        transaction_date: "2026-01-05",
        amount: -10.25,
      },
      {
        id: "t2",
        account_id: "btc",
        transaction_date: "2026-01-05",
        amount: 0.000025,
      },
      {
        id: "t3",
        account_id: "btc",
        transaction_date: "2026-01-06",
        amount: 0.00000002,
      },
      {
        id: "t4",
        account_id: "btc",
        transaction_date: "2026-03-01",
        amount: 1,
      },
    ],
  });

  it("advances a fiat opening balance by the trimmed rows, at four places", () => {
    const out = applyDateRange(tables(), "2026-02-01");
    expect(out.accounts.find((a) => a.id === "cad")?.opening_balance).toBe(
      90.25,
    );
  });

  it("keeps a coin's eight places when it advances the opening balance", () => {
    const out = applyDateRange(tables(), "2026-02-01");
    expect(out.accounts.find((a) => a.id === "btc")?.opening_balance).toBe(
      0.00002503,
    );
  });

  it("reads an account whose currency the export lacks as fiat: the coin shift rounds away", () => {
    const input = tables();
    delete (input as Partial<TableMap>).currencies;
    const out = applyDateRange(input, "2026-02-01");
    // At four places the 0.00002502 shift is nothing, so the row is untouched.
    expect(out.accounts.find((a) => a.id === "btc")?.opening_balance).toBe(
      0.00000001,
    );
  });
});
