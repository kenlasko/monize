import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { Security } from "@/securities/entities/security.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * End-to-end coverage for the per-security transaction history view: running
 * share totals across multiple (including closed) accounts, exact residual
 * balances, and adding adjustments to clean them up -- even for closed
 * accounts. An inactive security's rows are refused until it is activated
 * (INV-HOLDING-003, #2323): the cleanup is activate, adjust, deactivate.
 */
describe("Security transaction history (integration)", () => {
  let module: TestingModule;
  let service: InvestmentTransactionsService;
  let securitiesService: SecuritiesService;
  let dataSource: DataSource;
  let userId: string;
  let accountA: string;
  let accountB: string;
  let securityId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    service = module.get(InvestmentTransactionsService);
    securitiesService = module.get(SecuritiesService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  async function brokerage(name: string): Promise<string> {
    const acct = await createTestAccount(dataSource, userId, {
      name,
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, acct.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    return acct.id;
  }

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    accountA = await brokerage("Account A");
    accountB = await brokerage("Account B");

    const security = await withUserContext(userId, () =>
      securitiesService.create(userId, {
        symbol: "ACME",
        name: "Acme Corp",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;

    // Account A: add 100, remove all but a 0.001 residual.
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: accountA,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-01-01",
        securityId,
        quantity: 100,
      } as any),
    );
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: accountB,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-02-01",
        securityId,
        quantity: 50,
      } as any),
    );
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: accountA,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-03-01",
        securityId,
        quantity: 99.999,
      } as any),
    );

    // Close Account B and mark the security inactive (set directly: the app
    // blocks deactivating a security that still has holdings, but legacy/import
    // data can leave an inactive security with stray shares -- exactly the case
    // this view exists to clean up).
    await dataSource.manager.update(Account, accountB, { isClosed: true });
    await dataSource.manager.update(Security, securityId, { isActive: false });
  });

  it("reports running totals, closed accounts and exact residuals", async () => {
    const history = await withUserContext(userId, () =>
      service.getSecurityTransactionHistory(userId, securityId),
    );

    expect(history.isActive).toBe(false);
    expect(history.transactions).toHaveLength(3);

    // Chronological order: A +100, B +50, A -99.999.
    expect(history.transactions[0].accountId).toBe(accountA);
    expect(history.transactions[0].runningQuantityAccount).toBe(100);
    expect(history.transactions[1].runningQuantityAll).toBe(150);
    expect(history.transactions[2].runningQuantityAccount).toBeCloseTo(
      0.001,
      6,
    );
    expect(history.transactions[2].runningQuantityAll).toBeCloseTo(50.001, 6);

    const a = history.accounts.find((x) => x.accountId === accountA)!;
    const b = history.accounts.find((x) => x.accountId === accountB)!;
    expect(a.currentQuantity).toBeCloseTo(0.001, 6);
    expect(b.isClosed).toBe(true);
    expect(b.currentQuantity).toBe(50);
    expect(history.currentQuantityAll).toBeCloseTo(50.001, 6);
  });

  it("refuses an adjustment while the security is inactive, writing nothing (#2323)", async () => {
    await expect(
      withUserContext(userId, () =>
        service.create(userId, {
          accountId: accountA,
          action: InvestmentAction.REMOVE_SHARES,
          transactionDate: "2025-05-01",
          securityId,
          quantity: 0.001,
        } as any),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const history = await withUserContext(userId, () =>
      service.getSecurityTransactionHistory(userId, securityId),
    );
    expect(history.transactions).toHaveLength(3);
    expect(history.currentQuantityAll).toBeCloseTo(50.001, 6);
  });

  it("clears a residual via an adjustment once the security is activated", async () => {
    await withUserContext(userId, () =>
      securitiesService.activate(userId, securityId),
    );
    // Add a REMOVE_SHARES adjustment for the 0.001 residual in (open) A.
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: accountA,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-05-01",
        securityId,
        quantity: 0.001,
      } as any),
    );

    const history = await withUserContext(userId, () =>
      service.getSecurityTransactionHistory(userId, securityId),
    );
    const a = history.accounts.find((x) => x.accountId === accountA)!;
    expect(a.currentQuantity).toBeCloseTo(0, 6);
  });

  it("allows an adjustment against a closed account", async () => {
    await withUserContext(userId, () =>
      securitiesService.activate(userId, securityId),
    );
    // Remove the 50 shares stranded in the now-closed Account B.
    await withUserContext(userId, () =>
      service.create(userId, {
        accountId: accountB,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-05-01",
        securityId,
        quantity: 50,
      } as any),
    );

    const history = await withUserContext(userId, () =>
      service.getSecurityTransactionHistory(userId, securityId),
    );
    const b = history.accounts.find((x) => x.accountId === accountB)!;
    expect(b.currentQuantity).toBeCloseTo(0, 6);
    expect(history.currentQuantityAll).toBeCloseTo(0.001, 6);
  });
});
