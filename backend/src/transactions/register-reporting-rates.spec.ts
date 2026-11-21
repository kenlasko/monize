import { requestContextStorage } from "../common/request-context";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { attachRegisterReportingRates } from "./register-reporting-rates";

describe("attachRegisterReportingRates (issue #2308)", () => {
  const setup = () => {
    const preference = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };
    const { manager } = createScopedDbMocks([
      [UserPreference, preference as never],
    ]);
    return { manager };
  };

  const marketRates = [
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
  ];

  it("takes each foreign row at the market rate on its own date, never today's", async () => {
    const { manager } = setup();
    manager.query.mockResolvedValue(marketRates);
    const rows = [
      { id: "a", transactionDate: "2025-01-12", currencyCode: "USD" },
      { id: "b", transactionDate: "2025-06-12", currencyCode: "USD" },
      { id: "c", transactionDate: "2025-06-12", currencyCode: "CAD" },
    ];

    await attachRegisterReportingRates(manager as never, "user-1", rows);

    expect(
      rows.map((r) => (r as Record<string, unknown>).reportingRate),
    ).toEqual([1.25, 1.4, 1]);
    expect((rows[0] as Record<string, unknown>).reportingCurrencyCode).toBe(
      "CAD",
    );
  });

  it("converts a foreign entry paid in the reporting currency at its own rate (INV-FX-002)", async () => {
    const { manager } = setup();
    manager.query.mockResolvedValue(marketRates);
    const rows = [
      {
        id: "a",
        transactionDate: "2025-01-12",
        currencyCode: "USD",
        originalCurrencyCode: "CAD",
        // 0.8 USD per CAD, the rate the entry settled at.
        exchangeRate: "0.8",
      },
    ];

    await attachRegisterReportingRates(manager as never, "user-1", rows);

    expect((rows[0] as Record<string, unknown>).reportingRate).toBe(1.25);
    // No market history is needed for a row that carries its own rate.
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("converts the reader's own transfer leg at the amounts the transfer moved", async () => {
    const { manager } = setup();
    // The counterpart query answers 0.5 USD per CAD; no market rate is stored.
    manager.query.mockResolvedValueOnce([{ id: "t", transfer_rate: "0.5" }]);
    manager.query.mockResolvedValue([]);
    const rows = [
      {
        id: "t",
        transactionDate: "2025-01-12",
        currencyCode: "USD",
        isTransfer: true,
      },
    ];

    await requestContextStorage.run({ userId: "user-1" }, () =>
      attachRegisterReportingRates(manager as never, "user-1", rows),
    );

    expect((rows[0] as Record<string, unknown>).reportingRate).toBe(2);
    expect(manager.query.mock.calls[0][1]).toEqual([["t"], "CAD", "user-1"]);
  });

  it("keeps the market rate for a transfer leg on somebody else's ledger", async () => {
    const { manager } = setup();
    manager.query.mockResolvedValue(marketRates);
    const rows = [
      {
        id: "t",
        transactionDate: "2025-01-12",
        currencyCode: "USD",
        isTransfer: true,
      },
    ];

    await requestContextStorage.run({ userId: "someone-else" }, () =>
      attachRegisterReportingRates(manager as never, "user-1", rows),
    );

    expect((rows[0] as Record<string, unknown>).reportingRate).toBe(1.25);
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it("answers null, never 1, for a row no rate reaches", async () => {
    const { manager } = setup();
    manager.query.mockResolvedValue([]);
    const rows = [
      { id: "j", transactionDate: "2025-01-12", currencyCode: "JPY" },
    ];

    await attachRegisterReportingRates(manager as never, "user-1", rows);

    expect((rows[0] as Record<string, unknown>).reportingRate).toBeNull();
  });

  it("does nothing for an empty page", async () => {
    const { manager } = setup();
    await attachRegisterReportingRates(manager as never, "user-1", []);
    expect(manager.query).not.toHaveBeenCalled();
  });
});
