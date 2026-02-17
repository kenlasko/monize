import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { DemoSeedService } from "./demo-seed.service";
import { SeedService } from "./seed.service";
import { demoAccounts } from "./demo-seed-data/accounts";
import { demoPayees } from "./demo-seed-data/payees";
import { demoScheduledTransactions } from "./demo-seed-data/scheduled";
import { demoSecurities } from "./demo-seed-data/securities";
import { demoReports } from "./demo-seed-data/reports";

describe("DemoSeedService", () => {
  let service: DemoSeedService;
  let dataSource: Record<string, jest.Mock>;
  let seedService: Record<string, jest.Mock>;

  beforeEach(async () => {
    dataSource = {
      query: jest.fn(),
    };

    seedService = {
      seedAll: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DemoSeedService,
        { provide: DataSource, useValue: dataSource },
        { provide: SeedService, useValue: seedService },
      ],
    }).compile();

    service = module.get<DemoSeedService>(DemoSeedService);

    // Suppress console.log during tests
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("seedAll()", () => {
    beforeEach(() => {
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([{ id: "demo-user-id" }]);
        }
        if (sql.includes("RETURNING id")) {
          return Promise.resolve([{ id: "generated-uuid" }]);
        }
        if (sql.includes("COALESCE(SUM")) {
          return Promise.resolve([{ total: "0" }]);
        }
        return Promise.resolve([]);
      });
    });

    it("calls seedService.seedAll() first for currencies and base data", async () => {
      await service.seedAll();
      expect(seedService.seedAll).toHaveBeenCalledTimes(1);
    });

    it("looks up the demo user after base seeding", async () => {
      await service.seedAll();

      const userLookup = dataSource.query.mock.calls.find(
        (call: string[]) =>
          call[0].includes("SELECT id FROM users") &&
          call[0].includes("email"),
      );
      expect(userLookup).toBeDefined();
      expect(userLookup[1]).toContain("demo@monize.com");
    });

    it("throws if demo user is not found after base seeding", async () => {
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("SELECT id FROM users")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      await expect(service.seedAll()).rejects.toThrow(
        "Demo user not found after base seeding",
      );
    });

    it("deletes base seed data in FK-safe order before re-seeding", async () => {
      await service.seedAll();

      const deleteCalls = dataSource.query.mock.calls
        .filter((call: string[]) => call[0].includes("DELETE FROM"))
        .map((call: string[]) => call[0]);

      // Should delete in dependency order
      expect(deleteCalls.length).toBeGreaterThanOrEqual(14);
      expect(deleteCalls[0]).toContain("investment_transactions");
      expect(deleteCalls[deleteCalls.length - 1]).toContain("user_preferences");
    });
  });

  describe("seedDemoData()", () => {
    beforeEach(() => {
      dataSource.query.mockImplementation((sql: string) => {
        if (sql.includes("RETURNING id")) {
          return Promise.resolve([{ id: `uuid-${Math.random()}` }]);
        }
        if (sql.includes("COALESCE(SUM")) {
          return Promise.resolve([{ total: "0" }]);
        }
        return Promise.resolve([]);
      });
    });

    it("seeds categories with both income and expense types", async () => {
      await service.seedDemoData("user-123");

      const categoryCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO categories"),
      );

      // 4 income + 12 expense parents + subcategories
      expect(categoryCalls.length).toBeGreaterThanOrEqual(40);

      // Verify income categories exist
      const incomeInserts = categoryCalls.filter((call: (string | unknown[])[]) =>
        (call[0] as string).includes("is_income") &&
        (call[0] as string).includes("true"),
      );
      expect(incomeInserts.length).toBe(4);
    });

    it("seeds all demo accounts", async () => {
      await service.seedDemoData("user-123");

      const accountCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO accounts"),
      );

      // Regular accounts + investment pairs (cash + brokerage each)
      const investmentPairCount = demoAccounts.filter(
        (a) => a.isInvestmentPair,
      ).length;
      const regularCount = demoAccounts.length - investmentPairCount;
      // Each pair creates 2 accounts (cash + brokerage)
      expect(accountCalls.length).toBe(
        regularCount + investmentPairCount * 2,
      );
    });

    it("creates investment account pairs with bidirectional linking", async () => {
      await service.seedDemoData("user-123");

      // Look for the UPDATE that links cash to brokerage
      const linkUpdates = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("UPDATE accounts SET linked_account_id"),
      );

      // One link-back per investment pair + 1 for mortgage term_end_date
      const investmentPairCount = demoAccounts.filter(
        (a) => a.isInvestmentPair,
      ).length;
      expect(linkUpdates.length).toBe(investmentPairCount);
    });

    it("creates investment cash accounts with INVESTMENT_CASH sub-type", async () => {
      await service.seedDemoData("user-123");

      const cashAccounts = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("INSERT INTO accounts") &&
          call[0].includes("INVESTMENT_CASH"),
      );

      const investmentPairCount = demoAccounts.filter(
        (a) => a.isInvestmentPair,
      ).length;
      expect(cashAccounts.length).toBe(investmentPairCount);
    });

    it("creates investment brokerage accounts with INVESTMENT_BROKERAGE sub-type", async () => {
      await service.seedDemoData("user-123");

      const brokerageAccounts = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("INSERT INTO accounts") &&
          call[0].includes("INVESTMENT_BROKERAGE"),
      );

      const investmentPairCount = demoAccounts.filter(
        (a) => a.isInvestmentPair,
      ).length;
      expect(brokerageAccounts.length).toBe(investmentPairCount);
    });

    it("seeds all demo payees", async () => {
      await service.seedDemoData("user-123");

      const payeeCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO payees"),
      );

      // demoPayees + Transfer payee
      expect(payeeCalls.length).toBe(demoPayees.length + 1);
    });

    it("seeds transactions including regular, splits, and transfers", async () => {
      await service.seedDemoData("user-123");

      const txCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO transactions"),
      );

      // Should produce a substantial number of transactions
      expect(txCalls.length).toBeGreaterThan(100);
    });

    it("seeds split transactions with transaction_splits", async () => {
      await service.seedDemoData("user-123");

      const splitCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO transaction_splits"),
      );

      expect(splitCalls.length).toBeGreaterThan(0);
    });

    it("updates account balances after seeding transactions", async () => {
      await service.seedDemoData("user-123");

      const balanceUpdates = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("UPDATE accounts SET current_balance"),
      );

      expect(balanceUpdates.length).toBeGreaterThan(0);
    });

    it("seeds scheduled transactions", async () => {
      await service.seedDemoData("user-123");

      const scheduledCalls = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("INSERT INTO scheduled_transactions"),
      );

      expect(scheduledCalls.length).toBe(demoScheduledTransactions.length);
    });

    it("seeds securities with price history", async () => {
      await service.seedDemoData("user-123");

      const securityCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO securities"),
      );
      expect(securityCalls.length).toBe(demoSecurities.length);

      const priceCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO security_prices"),
      );
      // 12 months of trading days per security (~250 days each)
      expect(priceCalls.length).toBeGreaterThan(100);
    });

    it("seeds holdings for each security", async () => {
      await service.seedDemoData("user-123");

      const holdingCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO holdings"),
      );

      expect(holdingCalls.length).toBe(demoSecurities.length);
    });

    it("seeds BUY investment transactions for each security", async () => {
      await service.seedDemoData("user-123");

      const buyCalls = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("INSERT INTO investment_transactions") &&
          call[0].includes("'BUY'"),
      );

      // 3 BUY transactions per security
      expect(buyCalls.length).toBe(demoSecurities.length * 3);
    });

    it("seeds DIVIDEND transactions for ETFs", async () => {
      await service.seedDemoData("user-123");

      const dividendCalls = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("INSERT INTO investment_transactions") &&
          call[0].includes("'DIVIDEND'"),
      );

      const etfCount = demoSecurities.filter((s) => s.type === "ETF").length;
      // 4 quarterly dividends per ETF
      expect(dividendCalls.length).toBe(etfCount * 4);
    });

    it("seeds custom reports", async () => {
      await service.seedDemoData("user-123");

      const reportCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO custom_reports"),
      );

      expect(reportCalls.length).toBe(demoReports.length);
    });

    it("seeds user preferences", async () => {
      await service.seedDemoData("user-123");

      const prefCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO user_preferences"),
      );

      expect(prefCalls.length).toBe(1);
    });

    it("sets account created_at to 12 months ago", async () => {
      await service.seedDemoData("user-123");

      const accountCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO accounts"),
      );

      // Check that created_at parameter is roughly 12 months ago
      const firstAccountParams = accountCalls[0][1];
      const createdAt = new Date(firstAccountParams[firstAccountParams.length - 1]);
      const now = new Date();
      const monthsDiff =
        (now.getFullYear() - createdAt.getFullYear()) * 12 +
        (now.getMonth() - createdAt.getMonth());
      expect(monthsDiff).toBe(12);
    });

    it("sets mortgage term_end_date", async () => {
      await service.seedDemoData("user-123");

      const termEndUpdates = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("term_end_date"),
      );

      expect(termEndUpdates.length).toBe(1);
    });
  });
});
