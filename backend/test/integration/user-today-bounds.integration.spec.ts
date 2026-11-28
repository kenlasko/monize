import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// The securities module graph is circular; see the comment in
// holding-concurrent-trades.integration.spec.ts for why this import order is
// what makes the graph build.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { PortfolioCalculationService } from "@/securities/portfolio-calculation.service";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { NetWorthService } from "@/net-worth/net-worth.service";
import { todayInTimezone } from "@/common/date-utils";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * "Today" is the USER's day, not the server's or the database's (audit #2365,
 * family R2). The clock is fixed (only `Date` is faked) at an instant where the
 * user's calendar day differs from the server's UTC day, in both directions:
 *
 *  - Pacific/Kiritimati (UTC+14) at 12:00 UTC on 2026-11-27 is on 2026-11-28,
 *    a day AHEAD of the server;
 *  - America/Los_Angeles at 03:00 UTC on 2026-12-01 is on 2026-11-30, a day
 *    BEHIND the server, across a month change.
 *
 * A transaction dated the user's today is not in the future for them, so it
 * counts in the current month's net worth point, in the accounts summary, in a
 * holding rebuilt from a BUY and in the portfolio flows; and the snapshots end
 * at the user's month, so a chart load finds no account stale.
 */
const CASES = [
  {
    name: "a user ahead of the server (Pacific/Kiritimati)",
    timezone: "Pacific/Kiritimati",
    now: "2026-11-27T12:00:00Z",
    userToday: "2026-11-28",
    serverToday: "2026-11-27",
  },
  {
    name: "a user behind the server across a month change (America/Los_Angeles)",
    timezone: "America/Los_Angeles",
    now: "2026-12-01T03:00:00Z",
    userToday: "2026-11-30",
    serverToday: "2026-12-01",
  },
];

describe.each(CASES)(
  "the user's today bounds balances, holdings and flows, $name (integration, #2365)",
  ({ timezone, now, userToday: expectedToday, serverToday }) => {
    jest.setTimeout(60000);

    let module: TestingModule;
    let dataSource: DataSource;
    let accounts: AccountsService;
    let netWorth: NetWorthService;
    let investments: InvestmentTransactionsService;
    let calculation: PortfolioCalculationService;
    let userId: string;
    let userToday: string;
    let chequingId: string;
    let brokerageId: string;
    let fundingId: string;
    let securityId: string;

    beforeAll(async () => {
      // Only `Date`: the driver's timers and microtasks must keep running.
      jest.useFakeTimers({
        now: new Date(now),
        doNotFake: [
          "nextTick",
          "setImmediate",
          "clearImmediate",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "queueMicrotask",
          "hrtime",
          "performance",
        ],
      });
      module = await createIntegrationModule([
        AccountsModule,
        SecuritiesModule,
      ]);
      dataSource = module.get(DataSource);
      accounts = module.get(AccountsService);
      netWorth = module.get(NetWorthService, { strict: false });
      investments = module.get(InvestmentTransactionsService);
      calculation = module.get(PortfolioCalculationService, { strict: false });
    });

    afterAll(async () => {
      jest.useRealTimers();
      await module.close();
    });

    beforeEach(async () => {
      await cleanTables(dataSource, [
        "action_history",
        "holdings",
        "securities",
        "investment_transactions",
        "transaction_splits",
        "transactions",
        "monthly_account_balances",
        "accounts",
        "user_preferences",
        "users",
      ]);
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
      );

      userToday = todayInTimezone(timezone) as string;
      expect(userToday).toBe(expectedToday);
      expect(todayInTimezone("UTC")).toBe(serverToday);
      userId = (await createTestUserDirect(dataSource)).id;
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, default_currency, timezone)
       VALUES ($1, 'USD', $2)`,
        [userId, timezone],
      );

      const chequing = await createTestAccount(dataSource, userId, {
        name: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 750,
      });
      chequingId = chequing.id;
      await dataSource.query(
        `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          exchange_rate, description, status)
       VALUES ($1, $2, $3, -250, 'USD', 1, 'dated the user''s today', 'UNRECONCILED')`,
        [userId, chequingId, userToday],
      );

      const brokerage = await createTestAccount(dataSource, userId, {
        name: "Brokerage",
        openingBalance: 0,
        currentBalance: 0,
      });
      await dataSource.manager.update(Account, brokerage.id, {
        accountType: AccountType.INVESTMENT,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      });
      brokerageId = brokerage.id;
      fundingId = (
        await createTestAccount(dataSource, userId, {
          name: "Funding",
          openingBalance: 1000000,
          currentBalance: 1000000,
        })
      ).id;

      const security = await withUserContext(userId, () =>
        module.get(SecuritiesService).create(userId, {
          symbol: "AAA",
          name: "Triple A Corp",
          securityType: "STOCK" as any,
          currencyCode: "USD",
        } as any),
      );
      securityId = security.id;
    });

    it("counts a transaction dated the user's today in the current net worth month and the summary", async () => {
      await withUserContext(userId, () =>
        netWorth.recalculateAllAccounts(userId),
      );

      const [snapshot] = await dataSource.query(
        `SELECT balance FROM monthly_account_balances
        WHERE account_id = $1 AND month = DATE_TRUNC('month', $2::date)`,
        [chequingId, userToday],
      );
      expect(Number(snapshot.balance)).toBe(750);

      const summary = await withUserContext(userId, () =>
        accounts.getSummary(userId),
      );
      // Chequing 750 plus the untouched 1,000,000 funding account.
      expect(summary.netWorth).toBe(1000750);
      expect(summary.totalAssets).toBe(1000750);
    });

    it("ends the snapshots at the user's month, so a chart load finds nothing stale", async () => {
      await withUserContext(userId, () =>
        netWorth.recalculateAllAccounts(userId),
      );
      const recalculate = jest.spyOn(netWorth, "recalculateAccount");
      try {
        const months = await withUserContext(userId, () =>
          netWorth.getMonthlyNetWorth(userId),
        );

        expect(recalculate).not.toHaveBeenCalled();
        expect(months[months.length - 1].month).toBe(
          `${expectedToday.slice(0, 7)}-01`,
        );
      } finally {
        recalculate.mockRestore();
      }
    });

    it("makes a BUY dated the user's today a holding and counts it in the flows", async () => {
      await withUserContext(userId, () =>
        investments.create(userId, {
          accountId: brokerageId,
          action: InvestmentAction.BUY,
          transactionDate: userToday,
          securityId,
          fundingAccountId: fundingId,
          quantity: 5,
          price: 10,
          commission: 0,
        } as any),
      );

      const holdingRows = await dataSource.query(
        `SELECT quantity FROM holdings WHERE account_id = $1 AND security_id = $2`,
        [brokerageId, securityId],
      );
      expect(holdingRows).toHaveLength(1);
      expect(Number(holdingRows[0].quantity)).toBe(5);

      const flows = await withUserContext(userId, () =>
        calculation.computeInvestmentFlows(userId, [brokerageId]),
      );
      expect(flows.get(brokerageId)?.buys).toBe(50);

      const reporting = await withUserContext(userId, () =>
        calculation.computeNetInvestmentFlowsInReporting(
          userId,
          [brokerageId],
          "USD",
        ),
      );
      expect(reporting.get(brokerageId)).toBe(50);
    });
  },
);

/**
 * A joint account's snapshots end at its OWNER's month, the reader's at the
 * reader's. At 00:00 UTC on 2026-12-01 Tokyo is on 2026-12-01 and Los Angeles
 * on 2026-11-30, so the two sides are in different months. One reader's net
 * worth is read at the READER's month: an owner ahead must not make a month
 * only the joint account has the "latest", and an owner behind must not drop
 * out of the reader's current month (its latest snapshot is carried forward).
 */
describe.each([
  {
    name: "owner ahead (Tokyo), reader behind (Los Angeles)",
    ownerTimezone: "Asia/Tokyo",
    readerTimezone: "America/Los_Angeles",
    readerMonth: "2026-11-01",
  },
  {
    name: "owner behind (Los Angeles), reader ahead (Tokyo)",
    ownerTimezone: "America/Los_Angeles",
    readerTimezone: "Asia/Tokyo",
    readerMonth: "2026-12-01",
  },
])(
  "a joint account across timezones, $name (integration, #2365)",
  ({ ownerTimezone, readerTimezone, readerMonth }) => {
    jest.setTimeout(60000);

    let module: TestingModule;
    let dataSource: DataSource;
    let netWorth: NetWorthService;
    let ownerId: string;
    let readerId: string;
    let jointAccountId: string;

    beforeAll(async () => {
      // Only `Date`: the driver's timers and microtasks must keep running.
      jest.useFakeTimers({
        now: new Date("2026-12-01T00:00:00Z"),
        doNotFake: [
          "nextTick",
          "setImmediate",
          "clearImmediate",
          "setTimeout",
          "clearTimeout",
          "setInterval",
          "clearInterval",
          "queueMicrotask",
          "hrtime",
          "performance",
        ],
      });
      module = await createIntegrationModule([AccountsModule]);
      dataSource = module.get(DataSource);
      netWorth = module.get(NetWorthService, { strict: false });
    });

    afterAll(async () => {
      jest.useRealTimers();
      await module.close();
    });

    beforeEach(async () => {
      await cleanTables(dataSource, [
        "monthly_account_balances",
        "transaction_splits",
        "transactions",
        "account_delegate_grants",
        "account_delegates",
        "accounts",
        "user_preferences",
        "users",
      ]);
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places)
         VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
      );
      ownerId = (await createTestUserDirect(dataSource)).id;
      readerId = (await createTestUserDirect(dataSource)).id;
      for (const [id, timezone] of [
        [ownerId, ownerTimezone],
        [readerId, readerTimezone],
      ]) {
        await dataSource.query(
          `INSERT INTO user_preferences (user_id, default_currency, timezone)
           VALUES ($1, 'USD', $2)`,
          [id, timezone],
        );
      }
      // 900 + 100 for the reader and 4900 + 100 for the owner, the 100 dated
      // 2026-10-15 so both histories start in October whatever the wall clock.
      const readerAccount = await createTestAccount(dataSource, readerId, {
        name: "Reader chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
        openingBalance: 900,
        currentBalance: 1000,
      });
      const jointAccount = await createTestAccount(dataSource, ownerId, {
        name: "Joint chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
        openingBalance: 4900,
        currentBalance: 5000,
      });
      jointAccountId = jointAccount.id;
      for (const [userId, accountId] of [
        [readerId, readerAccount.id],
        [ownerId, jointAccount.id],
      ]) {
        await dataSource.query(
          `INSERT INTO transactions
             (user_id, account_id, transaction_date, amount, currency_code,
              exchange_rate, description, status)
           VALUES ($1, $2, '2026-10-15', 100, 'USD', 1, 'seed', 'UNRECONCILED')`,
          [userId, accountId],
        );
      }
      const [delegation] = await dataSource.query(
        `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [ownerId, readerId],
      );
      await dataSource.query(
        `INSERT INTO account_delegate_grants
           (delegation_id, account_id, can_read, can_create, can_edit, can_delete, is_joint)
         VALUES ($1, $2, true, false, false, false, true)`,
        [delegation.id, jointAccountId],
      );
      await withUserContext(ownerId, () =>
        netWorth.recalculateAllAccounts(ownerId),
      );
      await withUserContext(readerId, () =>
        netWorth.recalculateAllAccounts(readerId),
      );
    });

    const scope = () => ({
      accounts: [{ accountId: jointAccountId, ownerUserId: ownerId }],
    });

    it("reads the latest net worth at the reader's month, with the joint account in it", async () => {
      const latest = await withUserContext(readerId, () =>
        netWorth.getLatestNetWorth(readerId, scope()),
      );

      // 1,000 own + 5,000 joint: never the joint account alone (owner ahead),
      // never the reader alone (owner behind).
      expect(latest?.netWorth).toBe(6000);
    });

    it("ends the series at the reader's month and counts the joint account in it", async () => {
      const months = await withUserContext(readerId, () =>
        netWorth.getMonthlyNetWorth(readerId, "2026-10-01", undefined, scope()),
      );

      const last = months[months.length - 1];
      expect(last.month).toBe(readerMonth);
      expect(last.netWorth).toBe(6000);
    });
  },
);
