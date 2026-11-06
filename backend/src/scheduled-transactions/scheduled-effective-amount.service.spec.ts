import { Test, TestingModule } from "@nestjs/testing";
import { ScheduledEffectiveAmountService } from "./scheduled-effective-amount.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";

/**
 * The effective-amount contract (issue #1247), exercised on the two scenarios the
 * issue names: a persisted amount whose currency pair has since changed (stale),
 * and a pair whose current rate cannot be resolved (unknown).
 *
 * The numbers are the issue's own worked example: 10 shares at 100 EUR settling
 * into a CAD account, pinned at 1.50 EUR/CAD, so the stored amount is -1,500 CAD
 * -- and after the security's currency changes to USD at 1.35 USD/CAD the same
 * occurrence posts -1,350 CAD. Every assertion below also states what must NOT
 * come back, because the defect is a plausible number, not an error.
 */
describe("ScheduledEffectiveAmountService", () => {
  const userId = "11111111-1111-1111-1111-111111111111";
  let service: ScheduledEffectiveAmountService;
  let investmentTransactionsService: InvestmentFxMock;

  /** The issue's schedule: a monthly 10 x 100 BUY settling into CAD. */
  const investmentSchedule = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: "st-1",
      userId,
      accountId: "brokerage-1",
      name: "Monthly ETF buy",
      // The security-currency cash impact the form derives and persists.
      amount: -1000,
      // The brokerage account's currency, which is NOT the settlement currency.
      currencyCode: "CAD",
      frequency: "MONTHLY",
      nextDueDate: "2026-09-01",
      isActive: true,
      autoPost: false,
      isSplit: false,
      isTransfer: false,
      isInvestment: true,
      investmentAction: InvestmentAction.BUY,
      investmentSecurityId: "SEC-1",
      investmentFundingAccountId: "cash-1",
      investmentQuantity: 10,
      investmentPrice: 100,
      investmentCommission: 0,
      investmentTotalAmount: null,
      // Pinned when the security was still priced in EUR.
      investmentExchangeRate: 1.5,
      investmentExchangeRateFromCurrency: "EUR",
      investmentExchangeRateToCurrency: "CAD",
      splits: [],
      ...overrides,
    }) as unknown as ScheduledTransaction;

  const plainSchedule = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: "st-plain",
      userId,
      accountId: "chequing-1",
      name: "Rent",
      amount: -1200,
      currencyCode: "CAD",
      frequency: "MONTHLY",
      nextDueDate: "2026-09-01",
      isActive: true,
      isSplit: false,
      isTransfer: false,
      isInvestment: false,
      splits: [],
      ...overrides,
    }) as unknown as ScheduledTransaction;

  beforeEach(async () => {
    // The FX source beneath the real resolver. This suite drives the pair and
    // the rate per case, so the defaults are cleared to make an accidental
    // reliance on them a visible failure rather than a silent pass.
    investmentTransactionsService = createInvestmentFxMock();
    investmentTransactionsService.resolveSettlementCurrencyPair.mockReset();
    investmentTransactionsService.resolveCashExchangeRateOrNull.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledEffectiveAmountService,
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
      ],
    }).compile();

    service = module.get(ScheduledEffectiveAmountService);
  });

  /** The security's currency changed EUR -> USD; USD/CAD resolves at 1.35. */
  const currencyPairChangedToUsd = () => {
    investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
      { from: "USD", to: "CAD" },
    );
    investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
      1.35,
    );
  };

  describe("stale currency pair", () => {
    it("re-prices the occurrence at the current pair's rate", async () => {
      currencyPairChangedToUsd();

      const resolved = await service.resolveOne(userId, investmentSchedule());

      // 10 x 100 x 1.35, signed for a BUY.
      expect(resolved.base.amount).toBe(-1350);
      // The stale figure the persisted rate would give -- 11.11% out.
      expect(resolved.base.amount).not.toBe(-1500);
      expect(resolved.base.complete).toBe(true);
      // The settlement account's currency, not the brokerage's.
      expect(resolved.base.currencyCode).toBe("CAD");
    });

    it("does not reuse the persisted rate when its recorded pair no longer matches", async () => {
      currencyPairChangedToUsd();

      const resolved = await service.resolveOne(userId, investmentSchedule());

      expect(resolved.investmentForecastExchangeRate).toBe(1.35);
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalled();
    });

    it("reuses the persisted rate while its recorded pair IS still the current one", async () => {
      // Nothing changed: still EUR -> CAD, and posting reuses the pinned 1.50.
      // The projection has to agree with the posting, so it must NOT re-resolve.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      const resolved = await service.resolveOne(userId, investmentSchedule());

      expect(resolved.base.amount).toBe(-1500);
      expect(resolved.investmentForecastExchangeRate).toBe(1.5);
    });
  });

  describe("unknown currency pair", () => {
    it("reports the amount as unavailable, never the persisted snapshot", async () => {
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const resolved = await service.resolveOne(userId, investmentSchedule());

      expect(resolved.base.amount).toBeNull();
      expect(resolved.base.complete).toBe(false);
      // The whole point: "unknown" must not become a confident stale number.
      expect(resolved.base.amount).not.toBe(-1500);
      // ...and it still knows which currency the answer would have been in.
      expect(resolved.base.currencyCode).toBe("CAD");
    });

    it("treats a same-currency settlement as known, not unknown", async () => {
      // Zero FX needs no rate: 1:1 is a fact, and reporting it as unknown would
      // take a settled question away from the user.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "CAD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1,
      );

      const resolved = await service.resolveOne(userId, investmentSchedule());

      expect(resolved.base).toEqual({
        amount: -1000,
        currencyCode: "CAD",
        complete: true,
        directionAmount: -1000,
      });
    });
  });

  describe("schedules no exchange rate re-prices", () => {
    it("returns a plain schedule's stored amount as known", async () => {
      const resolved = await service.resolveOne(userId, plainSchedule());

      expect(resolved.base).toEqual({
        amount: -1200,
        currencyCode: "CAD",
        complete: true,
        directionAmount: -1200,
      });
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).not.toHaveBeenCalled();
    });

    it("normalizes the stored amount's float residue at the column scale", async () => {
      const resolved = await service.resolveOne(
        userId,
        plainSchedule({ amount: -1200.000000000004 as unknown as number }),
      );

      expect(resolved.base.amount).toBe(-1200);
    });

    it("keeps a BTC schedule's eight places: the amount posting will write (INV-MONEY-001)", async () => {
      // A stored amount was held to its currency's precision when written, so
      // the effective amount is the stored one; at four places this 2,500-sat
      // fee read as zero.
      const resolved = await service.resolveOne(
        userId,
        plainSchedule({
          amount: -0.000025 as unknown as number,
          currencyCode: "BTC",
        }),
      );

      expect(resolved.base.amount).toBe(-0.000025);
      expect(resolved.base.currencyCode).toBe("BTC");
    });
  });

  describe("embedded investment splits", () => {
    const splitSchedule = (): ScheduledTransaction =>
      ({
        id: "st-split",
        userId,
        accountId: "brokerage-1",
        name: "Buy plus fee",
        // The stale parent total: -1,500 at the old 1.50 plus a 25 fee line.
        amount: -1525,
        currencyCode: "CAD",
        frequency: "MONTHLY",
        nextDueDate: "2026-09-01",
        isActive: true,
        isSplit: true,
        isTransfer: false,
        isInvestment: false,
        splits: [
          {
            id: "sp-1",
            kind: SplitKind.INVESTMENT,
            amount: -1500,
            investmentAction: InvestmentAction.BUY,
            investmentSecurityId: "SEC-1",
            investmentQuantity: 10,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: 1.5,
            investmentExchangeRateFromCurrency: "EUR",
            investmentExchangeRateToCurrency: "CAD",
          },
          {
            id: "sp-2",
            kind: SplitKind.CATEGORY,
            amount: -25,
            investmentAction: null,
          },
        ],
      }) as unknown as ScheduledTransaction;

    it("re-sums the parent total at the current rate", async () => {
      currencyPairChangedToUsd();

      const resolved = await service.resolveOne(userId, splitSchedule());

      // -1,350 for the re-priced investment line, -25 for the untouched fee.
      expect(resolved.base.amount).toBe(-1375);
      expect(resolved.base.amount).not.toBe(-1525);
      expect(resolved.investmentForecastAmount).toBe(-1375);
    });

    it("withholds the whole total when one line's rate is unknown", async () => {
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const resolved = await service.resolveOne(userId, splitSchedule());

      expect(resolved.base.amount).toBeNull();
      expect(resolved.base.complete).toBe(false);
      // Not the fee line on its own either: a subtotal is not a total.
      expect(resolved.base.amount).not.toBe(-25);
    });
  });

  describe("per-occurrence overrides", () => {
    const override = (
      overrides: Partial<ScheduledTransactionOverride> = {},
    ): ScheduledTransactionOverride =>
      ({
        id: "ovr-1",
        scheduledTransactionId: "st-1",
        originalDate: "2026-09-01",
        overrideDate: "2026-09-03",
        amount: null,
        isSplit: null,
        splits: null,
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: null,
        ...overrides,
      }) as unknown as ScheduledTransactionOverride;

    it("re-prices an investment override's own quantity at the current rate", async () => {
      currencyPairChangedToUsd();

      const resolved = await service.resolveOne(
        userId,
        investmentSchedule({
          nextOverride: override({ investmentQuantity: 5 }),
        } as Partial<ScheduledTransaction>),
      );

      const occurrence = resolved.overrides.get("ovr-1")!;
      // 5 x 100 x 1.35.
      expect(occurrence.effective.amount).toBe(-675);
      expect(occurrence.effective.complete).toBe(true);
      // Neither the base occurrence nor the old rate's figure.
      expect(occurrence.effective.amount).not.toBe(-750);
      expect(occurrence.effective.amount).not.toBe(-1350);
    });

    it("marks an investment override unavailable when the current rate is unknown", async () => {
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const resolved = await service.resolveOne(
        userId,
        investmentSchedule({
          nextOverride: override({ investmentQuantity: 5 }),
        } as Partial<ScheduledTransaction>),
      );

      const occurrence = resolved.overrides.get("ovr-1")!;
      expect(occurrence.effective.amount).toBeNull();
      expect(occurrence.effective.complete).toBe(false);
    });

    it("uses a non-investment override's own stored amount", async () => {
      const resolved = await service.resolveOne(
        userId,
        plainSchedule({
          nextOverride: override({
            scheduledTransactionId: "st-plain",
            amount: -1350,
          }),
        } as Partial<ScheduledTransaction>),
      );

      expect(resolved.overrides.get("ovr-1")!.effective).toEqual({
        amount: -1350,
        currencyCode: "CAD",
        complete: true,
        directionAmount: -1350,
      });
    });

    it("falls through to the base occurrence for a date-only override", async () => {
      const resolved = await service.resolveOne(
        userId,
        plainSchedule({
          nextOverride: override({ scheduledTransactionId: "st-plain" }),
        } as Partial<ScheduledTransaction>),
      );

      expect(resolved.overrides.get("ovr-1")!.effective).toEqual(resolved.base);
    });
  });

  describe("resolveMany", () => {
    it("keys every schedule's answer by its own id", async () => {
      currencyPairChangedToUsd();

      const resolved = await service.resolveMany(userId, [
        investmentSchedule(),
        plainSchedule(),
      ]);

      expect(resolved.get("st-1")!.base.amount).toBe(-1350);
      expect(resolved.get("st-plain")!.base.amount).toBe(-1200);
    });

    it("asks the provider once per currency pair across all schedules", async () => {
      currencyPairChangedToUsd();

      await service.resolveMany(userId, [
        investmentSchedule({ id: "a" }),
        // A different security on the same settlement pair asks the provider the
        // same question, so the shared cache must answer the second one.
        investmentSchedule({ id: "b", investmentSecurityId: "SEC-2" }),
      ]);

      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalledTimes(1);
    });
  });
});
