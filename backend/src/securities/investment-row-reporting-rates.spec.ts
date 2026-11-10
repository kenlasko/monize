import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { attachInvestmentRowReportingRates } from "./investment-row-reporting-rates";

describe("attachInvestmentRowReportingRates (issue #2106)", () => {
  const setup = (rates: Array<Record<string, string>>) => {
    const preference = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };
    const accounts = {
      find: jest
        .fn()
        .mockResolvedValue([{ id: "cash-1", currencyCode: "EUR" }]),
    };
    const { manager } = createScopedDbMocks([
      [UserPreference, preference as never],
      [Account, accounts as never],
    ]);
    manager.query.mockResolvedValue(rates);
    return { manager, accounts };
  };

  it("stamps each row's factor into the reporting and the account currency at its own date", async () => {
    const { manager } = setup([
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate: "1.25",
        rate_date: "2025-01-10",
      },
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate: "1.40",
        rate_date: "2025-06-10",
      },
    ]);
    const rows = [
      // A USD dividend in a USD account, January and June.
      {
        transactionDate: "2025-01-12",
        exchangeRate: 1,
        amountCurrencyCode: "USD",
        account: { currencyCode: "USD", linkedAccountId: null },
        fundingAccount: null,
      },
      {
        transactionDate: "2025-06-12",
        exchangeRate: 1,
        amountCurrencyCode: "USD",
        account: { currencyCode: "USD", linkedAccountId: null },
        fundingAccount: null,
      },
    ];

    await attachInvestmentRowReportingRates(manager as never, "user-1", rows);

    expect(
      rows.map((r) => (r as Record<string, unknown>).reportingRate),
    ).toEqual([1.25, 1.4]);
    expect(rows.map((r) => (r as Record<string, unknown>).accountRate)).toEqual(
      [1, 1],
    );
    expect((rows[0] as Record<string, unknown>).reportingCurrencyCode).toBe(
      "CAD",
    );
    expect((rows[0] as Record<string, unknown>).ratesInto).toEqual({
      CAD: 1.25,
      USD: 1,
    });
  });

  it("reads the settlement currency from the brokerage's linked cash account", async () => {
    const { manager, accounts } = setup([]);
    const rows = [
      {
        transactionDate: "2025-01-12",
        // 0.92 EUR per USD, the rate the cash leg settled at in EUR.
        exchangeRate: 0.92,
        amountCurrencyCode: "USD",
        account: { currencyCode: "USD", linkedAccountId: "cash-1" },
        fundingAccount: null,
      },
    ];

    await attachInvestmentRowReportingRates(manager as never, "user-1", rows);

    expect(accounts.find).toHaveBeenCalled();
    // EUR is neither the reporting nor the account currency and no rate is
    // stored, so the onward hop and the market pair both answer null.
    expect((rows[0] as Record<string, unknown>).reportingRate).toBeNull();
    expect((rows[0] as Record<string, unknown>).accountRate).toBe(1);
  });

  it("does nothing for an empty page", async () => {
    const { manager } = setup([]);
    await attachInvestmentRowReportingRates(manager as never, "user-1", []);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
