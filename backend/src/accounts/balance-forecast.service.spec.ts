import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { BalanceForecastService } from "./balance-forecast.service";
import { Account } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { ScheduledEffectiveAmountService } from "../scheduled-transactions/scheduled-effective-amount.service";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { ScheduledTransactionLoanService } from "../scheduled-transactions/scheduled-transaction-loan.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// Pin only the clock. Replacing the whole module would delete its other
// exports -- `addDaysYMD` among them -- and the forecast would fail on a
// missing function rather than on anything this suite is about.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2024-07-08"),
}));

describe("BalanceForecastService", () => {
  let service: BalanceForecastService;
  let effectiveAmounts: ScheduledEffectiveAmountService;
  let accountsRepo: { findOne: jest.Mock };
  let scheduledRepo: { find: jest.Mock };
  let overridesRepo: { find: jest.Mock };
  let dataSource: { query: jest.Mock };
  let investmentTransactionsService: InvestmentFxMock;

  beforeEach(async () => {
    accountsRepo = { findOne: jest.fn() };
    scheduledRepo = { find: jest.fn() };
    overridesRepo = { find: jest.fn().mockResolvedValue([]) };
    const mocks = createScopedDbMocks([
      [Account, accountsRepo],
      [ScheduledTransaction, scheduledRepo],
      [ScheduledTransactionOverride, overridesRepo],
    ]);
    // Raw SQL runs through the transaction manager; tests program it here.
    dataSource = { query: mocks.manager.query };

    // Issue #1247: the projection's amounts and the account each occurrence is
    // charged to come from the real resolver, so the double sits beneath it.
    // Defaults are same-currency and same-account, which is what the
    // pre-existing expectations below assume.
    investmentTransactionsService = createInvestmentFxMock();
    // This suite charts a CAD account, so the uninteresting default is CAD/CAD.
    investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
      { from: "CAD", to: "CAD" },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceForecastService,
        // Both read-side services are real, over a stubbed FX source: the dates,
        // the amounts and the account each occurrence is charged to ARE their
        // output, so a double would test nothing (issue #1247).
        ScheduledOccurrenceService,
        // No loan bill here: the per-occurrence loan pricing is
        // `scheduled-occurrence.service.spec.ts`'s.
        {
          provide: ScheduledTransactionLoanService,
          useValue: {
            projectLoanOccurrencesMany: jest.fn().mockResolvedValue(new Map()),
          },
        },
        ScheduledEffectiveAmountService,
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        { provide: DataSource, useValue: mocks.dataSource },
      ],
    }).compile();

    service = module.get(BalanceForecastService);
    effectiveAmounts = module.get(ScheduledEffectiveAmountService);
  });

  /** The two raw reads the service makes, in order. */
  const stubBalances = (
    startBalance: string,
    futureActuals: { date: string; total: string }[] = [],
  ) => {
    dataSource.query
      .mockResolvedValueOnce([{ balance: startBalance }])
      .mockResolvedValueOnce(futureActuals);
  };

  const chequing = {
    id: "acc-1",
    currencyCode: "CAD",
    openingBalance: 0,
    currentBalance: 1000,
  };

  /** The issue's schedule: 10 x 100 pinned at 1.50 while priced in EUR. */
  const investmentSchedule = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    id: "st-inv",
    name: "Monthly ETF buy",
    accountId: "brokerage-1",
    transferAccountId: null,
    // The security-currency cash impact, under the brokerage's own code.
    amount: -1000,
    currencyCode: "CAD",
    frequency: "MONTHLY",
    nextDueDate: "2024-07-20",
    endDate: null,
    occurrencesRemaining: null,
    isActive: true,
    isSplit: false,
    isTransfer: false,
    isInvestment: true,
    investmentAction: "BUY",
    investmentSecurityId: "SEC-1",
    // Funded from the chequing account being charted.
    investmentFundingAccountId: "acc-1",
    investmentQuantity: 10,
    investmentPrice: 100,
    investmentCommission: 0,
    investmentExchangeRate: 1.5,
    investmentExchangeRateFromCurrency: "EUR",
    investmentExchangeRateToCurrency: "CAD",
    splits: [],
    ...overrides,
  });

  it("projects the current balance forward using scheduled occurrences", async () => {
    accountsRepo.findOne.mockResolvedValue({
      id: "acc-1",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 1000,
    });
    // start-balance query, then future-actuals query.
    stubBalances("1000");
    scheduledRepo.find.mockResolvedValue([
      {
        id: "st-1",
        name: "Rent",
        accountId: "acc-1",
        transferAccountId: null,
        amount: -200,
        // A real row always carries its account's currency, and the projection
        // compares it against the account being charted rather than assuming.
        currencyCode: "CAD",
        frequency: "MONTHLY",
        nextDueDate: "2024-07-20",
        endDate: null,
        occurrencesRemaining: null,
        isInvestment: false,
        isSplit: false,
        splits: [],
      },
    ]);

    const result = await service.getBalanceForecast("user-1", "acc-1", 60);

    expect(result.complete).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.accountId).toBe("acc-1");
    expect(result.currencyCode).toBe("CAD");
    // Anchor at today, then -200 on Jul 20 (Aug 20 is past the 60-day horizon).
    expect(result.points[0]).toEqual({ date: "2024-07-08", balance: 1000 });
    expect(result.points).toContainEqual({ date: "2024-07-20", balance: 800 });
  });

  it("merges future-dated real transactions into the forecast", async () => {
    accountsRepo.findOne.mockResolvedValue({
      id: "acc-1",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 500,
    });
    stubBalances("500", [{ date: "2024-07-25", total: "300" }]);
    scheduledRepo.find.mockResolvedValue([]);

    const result = await service.getBalanceForecast("user-1", "acc-1", 60);

    expect(result.points).toContainEqual({ date: "2024-07-25", balance: 800 });
    expect(result.complete).toBe(true);
  });

  it("throws NotFound when the account is not owned", async () => {
    accountsRepo.findOne.mockResolvedValue(null);
    await expect(service.getBalanceForecast("user-1", "acc-1")).rejects.toThrow(
      NotFoundException,
    );
  });

  // ---- The effective-amount contract (issue #1247) ----

  describe("investment schedules settle where the cash actually moves", () => {
    it("charges the funding account, at the current rate, not the brokerage", async () => {
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([investmentSchedule()]);
      // The security is USD now, and USD -> CAD resolves at 1.35.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      // 10 x 100 x 1.35 leaves the chequing account, which the old
      // `accountId`/`transferAccountId` filter could not see at all.
      expect(result.complete).toBe(true);
      expect(result.points).toContainEqual({
        date: "2024-07-20",
        balance: -350,
      });
      // Not the pre-FX impact, and not the stale 1.50 figure.
      expect(result.points).not.toContainEqual({
        date: "2024-07-20",
        balance: 0,
      });
      expect(result.points).not.toContainEqual({
        date: "2024-07-20",
        balance: -500,
      });
    });

    it("leaves the brokerage's own projection alone", async () => {
      accountsRepo.findOne.mockResolvedValue({
        ...chequing,
        id: "brokerage-1",
      });
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([investmentSchedule()]);

      const result = await service.getBalanceForecast(
        "user-1",
        "brokerage-1",
        60,
      );

      // The cash settles in the chequing account, so the brokerage's balance
      // does not move -- it used to be charged the security-currency figure.
      expect(result.points).toEqual([{ date: "2024-07-08", balance: 1000 }]);
      expect(result.complete).toBe(true);
    });
  });

  describe("an occurrence nobody can price withholds the series", () => {
    it("returns only today's anchor and names the schedule and pair", async () => {
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([investmentSchedule()]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      // A running balance is cumulative: today is a known fact, nothing after
      // it is. The stale figure appears nowhere.
      expect(result.points).toEqual([{ date: "2024-07-08", balance: 1000 }]);
      expect(result.complete).toBe(false);
      expect(result.gaps).toEqual([
        {
          scheduledTransactionId: "st-inv",
          name: "Monthly ETF buy",
          reason: "unresolvedSettlementRate",
          // The pair that failed, not just "something did".
          fromCurrency: "USD",
          toCurrency: "CAD",
        },
      ]);
    });

    it("names the pair that failed, so the reader can go and fix it", async () => {
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([investmentSchedule()]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      // "no rate from USD to CAD" is actionable; "unavailable" is not.
      expect(result.gaps[0]).toMatchObject({
        reason: "unresolvedSettlementRate",
        fromCurrency: "USD",
        toCurrency: "CAD",
      });
    });

    it("withholds a transfer arriving from an account in another currency", async () => {
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([
        {
          id: "st-xfer",
          name: "From USD savings",
          accountId: "usd-savings",
          transferAccountId: "acc-1",
          // The SOURCE account's currency; the arriving amount is resolved when
          // it posts, and this endpoint applies no rate.
          amount: -500,
          currencyCode: "USD",
          frequency: "MONTHLY",
          nextDueDate: "2024-07-20",
          endDate: null,
          occurrencesRemaining: null,
          isActive: true,
          isTransfer: true,
          isInvestment: false,
          isSplit: false,
          splits: [],
        },
      ]);

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      // 500 USD is not 500 CAD, so it is reported rather than added.
      expect(result.complete).toBe(false);
      expect(result.points).toEqual([{ date: "2024-07-08", balance: 1000 }]);
      expect(result.gaps[0]).toEqual({
        scheduledTransactionId: "st-xfer",
        name: "From USD savings",
        reason: "crossCurrencyTransfer",
        fromCurrency: "USD",
        toCurrency: "CAD",
      });
    });

    it("still projects a same-currency transfer into this account", async () => {
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([
        {
          id: "st-xfer",
          name: "From savings",
          accountId: "savings",
          transferAccountId: "acc-1",
          amount: -500,
          currencyCode: "CAD",
          frequency: "MONTHLY",
          nextDueDate: "2024-07-20",
          endDate: null,
          occurrencesRemaining: null,
          isActive: true,
          isTransfer: true,
          isInvestment: false,
          isSplit: false,
          splits: [],
        },
      ]);

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      expect(result.complete).toBe(true);
      expect(result.points).toContainEqual({
        date: "2024-07-20",
        balance: 1500,
      });
    });

    it("withholds when the resolved amount is in another currency than the account", async () => {
      // `base.currencyCode` is the settlement account's currency by
      // construction, so this branch should be unreachable -- it is the guard
      // that keeps "one wrong number for another" from ever shipping, and it is
      // tested by making the resolver answer wrongly on purpose.
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([investmentSchedule()]);
      jest.spyOn(effectiveAmounts, "resolveMany").mockResolvedValue(
        new Map([
          [
            "st-inv",
            {
              base: {
                amount: -1350,
                currencyCode: "USD",
                complete: true,
                directionAmount: -1350,
              },
              settlementAccountId: "acc-1",
              settlementPair: { from: "EUR", to: "USD" },
              investmentForecastExchangeRate: 1.35,
              investmentForecastAmount: null,
              overrides: new Map(),
            },
          ],
        ]),
      );

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      expect(result.complete).toBe(false);
      expect(result.gaps[0]).toMatchObject({
        reason: "unresolvedSettlementRate",
        fromCurrency: "USD",
        toCurrency: "CAD",
      });
      expect(result.points).toEqual([{ date: "2024-07-08", balance: 1000 }]);
    });
  });

  describe("per-occurrence overrides", () => {
    it("moves and re-prices an overridden occurrence", async () => {
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([
        {
          id: "st-1",
          name: "Rent",
          accountId: "acc-1",
          transferAccountId: null,
          amount: -200,
          currencyCode: "CAD",
          frequency: "MONTHLY",
          nextDueDate: "2024-07-20",
          endDate: null,
          occurrencesRemaining: null,
          isActive: true,
          isInvestment: false,
          isSplit: false,
          splits: [],
        },
      ]);
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-1",
          originalDate: "2024-07-20",
          overrideDate: "2024-07-25",
          amount: -350,
        },
      ]);

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      // The account chart now agrees with the cash-flow forecast, which has
      // honoured overrides all along.
      expect(result.points).toContainEqual({
        date: "2024-07-25",
        balance: 650,
      });
      expect(result.points.some((p) => p.date === "2024-07-20")).toBe(false);
    });

    it("withholds the series when an override cannot be priced, base or not", async () => {
      // An override can be unknown while the base occurrence is known -- an
      // investment line added to one occurrence of an ordinary schedule. The
      // occurrence must not quietly fall back to the base amount.
      accountsRepo.findOne.mockResolvedValue(chequing);
      stubBalances("1000");
      scheduledRepo.find.mockResolvedValue([
        {
          id: "st-1",
          name: "Rent",
          accountId: "acc-1",
          transferAccountId: null,
          amount: -200,
          currencyCode: "CAD",
          frequency: "MONTHLY",
          nextDueDate: "2024-07-20",
          endDate: null,
          occurrencesRemaining: null,
          isActive: true,
          isInvestment: false,
          isSplit: false,
          splits: [],
        },
      ]);
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "st-1",
          originalDate: "2024-07-20",
          overrideDate: "2024-07-20",
          amount: null,
          isSplit: true,
          splits: [
            {
              id: "osp-1",
              amount: -350,
              investment: {
                securityId: "SEC-1",
                action: "BUY",
                quantity: 10,
                price: 100,
                commission: 0,
                exchangeRate: 1.5,
                exchangeRateFromCurrency: "EUR",
                exchangeRateToCurrency: "CAD",
              },
            },
          ],
        },
      ]);
      // The security is USD now and no USD -> CAD rate resolves.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getBalanceForecast("user-1", "acc-1", 60);

      expect(result.complete).toBe(false);
      expect(result.gaps).toHaveLength(1);
      // Neither the base -200 nor the override's stale -350 reaches the series.
      expect(result.points).toEqual([{ date: "2024-07-08", balance: 1000 }]);
    });
  });
});
