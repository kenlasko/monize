import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { PortfolioMovementAlertService } from "@/notification-center/portfolio-movement-alert.service";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import type {
  PortfolioService,
  PortfolioSummary,
} from "@/securities/portfolio.service";
import { EMPTY_RETURN_DIAGNOSTICS } from "@/securities/return-diagnostics.util";
import type { ExchangeRateService } from "@/currencies/exchange-rate.service";
import type { NotificationDispatchService } from "@/notifications/notification-dispatch.service";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The external-flow classification, run as SQL against a real PostgreSQL.
 *
 * `external-flow.util.spec.ts` can only assert the TEXT of the predicate, and
 * its own doc comment says so: whether the clauses actually keep and drop the
 * rows they claim to needs a database with the investment account pair, a
 * transfer on each side of the boundary and an embedded-investment split. This
 * suite runs the statement the producer issues -- `perDay: true`, through
 * `PortfolioMovementAlertService` itself -- and asserts what it does today,
 * both the rows and the per-day conversion built on top of them.
 *
 * The three cases named in `external-flow.util.ts`:
 *
 *  - a transfer between two accounts INSIDE the scope never crossed the
 *    boundary, so neither leg counts;
 *  - a transfer from an ordinary account INTO the scope did cross it, so the
 *    scoped leg counts (and the unscoped leg is simply not in the query);
 *  - a split parent mixing an embedded investment line with an ordinary cash
 *    line is excluded WHOLE. That is the util's documented coarse case, not a
 *    defect discovered here: the sum is over `t.amount`, so the statement cannot
 *    keep one line and drop another. Pinned so the day it becomes line-granular
 *    is a deliberate change with a failing test, not a silent one.
 */
describe("portfolio movement external flow (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;

  const today = todayYMD();
  const baselineOn = addDaysYMD(today, -4);
  const dayOne = addDaysYMD(today, -3);
  const dayTwo = addDaysYMD(today, -1);

  let cash: Account;
  let brokerage: Account;
  let chequing: Account;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "notification_portfolio_state",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    cash = await createTestAccount(dataSource, userId, {
      name: "Brokerage cash",
      accountType: AccountType.INVESTMENT,
      currencyCode: "USD",
    });
    brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      accountType: AccountType.INVESTMENT,
      currencyCode: "USD",
    });
    chequing = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      accountType: AccountType.CHEQUING,
      currencyCode: "USD",
    });

    await dataSource.query(
      `INSERT INTO notification_portfolio_state
         (user_id, move_alert_percent, baseline_value, baseline_currency,
          baseline_captured_on, baseline_positions)
       VALUES ($1, 5, 100000, 'USD', $2, '[]'::jsonb)`,
      [userId, baselineOn],
    );
  });

  const addTransaction = async (
    over: Partial<Transaction> & { accountId: string },
  ): Promise<Transaction> => {
    const row = dataSource.manager.create(Transaction, {
      userId,
      transactionDate: dayOne,
      amount: 0,
      currencyCode: "USD",
      exchangeRate: 1,
      description: "seed",
      status: TransactionStatus.UNRECONCILED,
      ...over,
    } as never);
    return dataSource.manager.save(row);
  };

  /**
   * Run the producer with the real database behind its flow query and stubs for
   * everything that is not this suite's subject. `mvToday` is chosen per case so
   * the alert fires, because the fired payload is where the flow the SQL
   * produced becomes observable.
   */
  const runProducer = async (
    mvToday: number,
    rates: Record<string, number>,
  ) => {
    const summary = {
      totalCashValue: 0,
      totalHoldingsValue: mvToday,
      totalCostBasis: 0,
      totalNetInvested: 0,
      totalPortfolioValue: mvToday,
      totalGainOverNetInvested: mvToday,
      totalGainLoss: 0,
      knownCashValueSubtotal: 0,
      knownHoldingsValueSubtotal: mvToday,
      knownCostBasisSubtotal: 0,
      knownNetInvestedSubtotal: 0,
      knownPortfolioValueSubtotal: mvToday,
      knownGainOverNetInvestedSubtotal: mvToday,
      knownGainLossSubtotal: 0,
      totalGainLossPercent: 0,
      gainCostBasis: 0,
      unpricedCostBasis: 0,
      timeWeightedReturn: null,
      timeWeightedReturnReasons: [],
      timeWeightedReturnSince: null,
      moneyWeightedReturn: null,
      moneyWeightedReturnReasons: [],
      returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
      cagr: null,
      fxComplete: true,
      missingRatePairs: [],
      pricesComplete: true,
      unpricedSecurityIds: [],
      valuationComplete: true,
      // No holdings: the late-price rule has its own unit coverage, and
      // leaving it out keeps this suite about the flow SQL.
      holdings: [],
      holdingsByAccount: [],
      allocation: [],
    } satisfies PortfolioSummary;

    const getRateForDate = jest
      .fn<Promise<number | null>, [string, string, string | Date]>()
      .mockImplementation(async (from, to, on) => {
        if (from === to) return 1;
        const key = `${from}@${String(on)}`;
        return key in rates ? rates[key] : null;
      });
    const notify = jest.fn().mockResolvedValue({ id: "written" });

    const service = new PortfolioMovementAlertService(
      dataSource,
      {
        getPortfolioSummary: jest.fn().mockResolvedValue(summary),
        getLatestPriceObservations: jest.fn().mockResolvedValue(new Map()),
      } as Pick<
        PortfolioService,
        "getPortfolioSummary" | "getLatestPriceObservations"
      > as PortfolioService,
      { getRateForDate } as Pick<
        ExchangeRateService,
        "getRateForDate"
      > as ExchangeRateService,
      { notify } as Pick<
        NotificationDispatchService,
        "notify"
      > as NotificationDispatchService,
    );

    await service.run();
    return { notify, getRateForDate };
  };

  it("counts a deposit and a transfer that crossed the boundary, and neither leg of one that did not", async () => {
    // Crossed: an ordinary deposit into the investment cash sleeve.
    await addTransaction({ accountId: cash.id, amount: 1000 });
    // Crossed: chequing -> investment cash. Only the scoped leg is in the query
    // at all, and it must count, because the money came from outside the set.
    const outLeg = await addTransaction({
      accountId: chequing.id,
      transactionDate: dayTwo,
      amount: -500,
      isTransfer: true,
    });
    const inLeg = await addTransaction({
      accountId: cash.id,
      transactionDate: dayTwo,
      amount: 500,
      isTransfer: true,
      linkedTransactionId: outLeg.id,
    });
    await dataSource.manager.update(Transaction, outLeg.id, {
      linkedTransactionId: inLeg.id,
    });
    // Not crossed: cash sleeve -> brokerage sleeve, both inside the scope.
    const internalOut = await addTransaction({
      accountId: cash.id,
      amount: -2000,
      isTransfer: true,
    });
    const internalIn = await addTransaction({
      accountId: brokerage.id,
      amount: 2000,
      isTransfer: true,
      linkedTransactionId: internalOut.id,
    });
    await dataSource.manager.update(Transaction, internalOut.id, {
      linkedTransactionId: internalIn.id,
    });
    // A VOID row moved no cash (INV-TRANSFER-001).
    await addTransaction({
      accountId: cash.id,
      transactionDate: dayTwo,
      amount: 9999,
      status: TransactionStatus.VOID,
    });

    // movement = 99,500 - 100,000 - 1,500 = -2,000 -> -2% of the baseline is
    // below the 5% threshold, so choose a value that fires and read the flow.
    const { notify } = await runProducer(90_000, {});

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1].data).toMatchObject({
      externalFlow: 1500,
      movementValue: -11_500,
      baselineValue: 100_000,
      currentValue: 90_000,
    });
  });

  it("excludes a split parent that mixes an investment line with a cash line, whole", async () => {
    const mixed = await addTransaction({
      accountId: cash.id,
      transactionDate: dayTwo,
      amount: -200,
      isSplit: true,
    });
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, [
        {
          transactionId: mixed.id,
          kind: SplitKind.INVESTMENT,
          amount: -150,
        },
        {
          transactionId: mixed.id,
          kind: SplitKind.CATEGORY,
          amount: -50,
        },
      ] as never),
    );
    // A plain deposit, so a zero flow cannot pass for "the predicate ran".
    await addTransaction({ accountId: cash.id, amount: 1000 });

    const { notify } = await runProducer(90_000, {});

    // The 50 of ordinary cash inside the mixed parent is dropped with it. This
    // is the util's documented coarse case; making it line-granular is a
    // spec-guided follow-up, not a change to slip in here.
    expect(notify.mock.calls[0][1].data.externalFlow).toBe(1000);
  });

  it("prices each day's subtotal at that day's rate, per currency", async () => {
    await addTransaction({ accountId: cash.id, amount: 1000 });
    await addTransaction({
      accountId: cash.id,
      transactionDate: dayOne,
      amount: 1000,
      currencyCode: "CAD",
    });
    await addTransaction({
      accountId: cash.id,
      transactionDate: dayTwo,
      amount: 1000,
      currencyCode: "CAD",
    });

    const { notify, getRateForDate } = await runProducer(90_000, {
      [`CAD@${dayOne}`]: 0.7,
      [`CAD@${dayTwo}`]: 0.8,
      [`CAD@${today}`]: 0.9,
    });

    // 1,000 USD + 1,000 CAD at 0.70 + 1,000 CAD at 0.80. At the run day's 0.90
    // the same rows would read 2,800 and the extra 300 would be reported as a
    // market move (INV-PORTMOVE-007).
    expect(notify.mock.calls[0][1].data.externalFlow).toBe(2500);
    expect(getRateForDate).toHaveBeenCalledWith("CAD", "USD", dayOne);
    expect(getRateForDate).toHaveBeenCalledWith("CAD", "USD", dayTwo);
    expect(getRateForDate).not.toHaveBeenCalledWith("CAD", "USD", today);

    // The advanced baseline carries its per-security closes as a JSON array
    // (none here: no holdings), which the next run reads back and compares
    // against rather than replacing (INV-PORTMOVE-008).
    const [state] = await dataSource.query(
      `SELECT jsonb_typeof(baseline_positions) AS kind,
              jsonb_array_length(baseline_positions) AS count
         FROM notification_portfolio_state WHERE user_id = $1`,
      [userId],
    );
    expect(state).toEqual({ kind: "array", count: 0 });
  });

  it("withholds the alert and the baseline when one day's rate is missing", async () => {
    await addTransaction({
      accountId: cash.id,
      amount: 1000,
      currencyCode: "CAD",
    });

    const { notify } = await runProducer(90_000, {});

    expect(notify).not.toHaveBeenCalled();
    const [state] = await dataSource.query(
      `SELECT baseline_value::TEXT AS value,
              TO_CHAR(baseline_captured_on, 'YYYY-MM-DD') AS captured_on
         FROM notification_portfolio_state WHERE user_id = $1`,
      [userId],
    );
    // A subtotal must never become a baseline (INV-PORTMOVE-001).
    expect(Number(state.value)).toBe(100_000);
    expect(state.captured_on).toBe(baselineOn);
  });
});
