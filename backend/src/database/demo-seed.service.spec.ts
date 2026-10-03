import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { DemoSeedService } from "./demo-seed.service";
import { SeedService } from "./seed.service";
import { FaviconService } from "../common/favicon/favicon.service";
import { demoAccounts } from "./demo-seed-data/accounts";
import { demoInstitutions } from "./demo-seed-data/institutions";
import { demoPayees, DemoPayee } from "./demo-seed-data/payees";
import { demoScheduledTransactions } from "./demo-seed-data/scheduled";
import { demoSecurities } from "./demo-seed-data/securities";
import { demoReports } from "./demo-seed-data/reports";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("DemoSeedService", () => {
  let service: DemoSeedService;
  let dataSource: Record<string, jest.Mock>;
  let seedService: Record<string, jest.Mock>;
  let logoService: Record<string, jest.Mock>;

  beforeEach(async () => {
    const scoped = createScopedDbMocks([]);
    scoped.dataSource.query = scoped.manager.query;
    dataSource = scoped.dataSource as unknown as Record<string, jest.Mock>;

    seedService = {
      seedAll: jest.fn().mockResolvedValue(undefined),
    };

    logoService = {
      fetchFavicon: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DemoSeedService,
        { provide: DataSource, useValue: dataSource },
        { provide: SeedService, useValue: seedService },
        { provide: FaviconService, useValue: logoService },
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
          call[0].includes("SELECT id FROM users") && call[0].includes("email"),
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
      const incomeInserts = categoryCalls.filter(
        (call: (string | unknown[])[]) =>
          (call[0] as string).includes("is_income") &&
          (call[0] as string).includes("true"),
      );
      expect(incomeInserts.length).toBe(4);
    });

    it("seeds an institution for each distinct demo institution", async () => {
      await service.seedDemoData("user-123");

      const institutionCalls = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO institutions"),
      );
      expect(institutionCalls.length).toBe(demoInstitutions.length);
    });

    it("links accounts to their institution via institution_id", async () => {
      // Return a stable id per institution insert so we can assert linkage.
      dataSource.query.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO institutions")) {
          return Promise.resolve([{ id: `inst-${params?.[1] as string}` }]);
        }
        if (sql.includes("RETURNING id")) {
          return Promise.resolve([{ id: `uuid-${Math.random()}` }]);
        }
        if (sql.includes("COALESCE(SUM")) {
          return Promise.resolve([{ total: "0" }]);
        }
        return Promise.resolve([]);
      });

      await service.seedDemoData("user-123");

      const accountInserts = dataSource.query.mock.calls.filter(
        (call: string[]) => call[0].includes("INSERT INTO accounts"),
      );
      // Every INSERT INTO accounts statement carries an institution_id column.
      for (const call of accountInserts) {
        expect(call[0]).toContain("institution_id");
      }
      // At least one account is linked to a seeded institution id.
      const linked = accountInserts.some((call: unknown[]) =>
        (call[1] as unknown[]).some(
          (p) => typeof p === "string" && p.startsWith("inst-"),
        ),
      );
      expect(linked).toBe(true);
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
      expect(accountCalls.length).toBe(regularCount + investmentPairCount * 2);
    });

    it("creates investment account pairs with bidirectional linking", async () => {
      await service.seedDemoData("user-123");

      // Look for the UPDATE that links cash to brokerage
      const linkUpdates = dataSource.query.mock.calls.filter((call: string[]) =>
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

      const payeeCalls = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO payees"),
      );

      // demoPayees + Transfer payee
      expect(payeeCalls.length).toBe(demoPayees.length + 1);
    });

    it("writes each payee's website, address and phone", async () => {
      await service.seedDemoData("user-123");

      const sample = demoPayees.find((payee) => payee.website) as DemoPayee;
      const insert = dataSource.query.mock.calls.find(
        (call: [string, unknown[]]) =>
          call[0].includes("INSERT INTO payees") && call[1][1] === sample.name,
      );

      expect(insert[0]).toContain("website");
      expect(insert[1]).toEqual(
        expect.arrayContaining([sample.website, sample.address, sample.phone]),
      );
    });

    it("leaves the contact details of a payee that has none null", async () => {
      await service.seedDemoData("user-123");

      // A person or a private client carries no website, and a made-up one
      // would render a broken icon and a link to nowhere.
      const bare = demoPayees.find((payee) => !payee.website) as DemoPayee;
      const insert = dataSource.query.mock.calls.find(
        (call: [string, unknown[]]) =>
          call[0].includes("INSERT INTO payees") && call[1][1] === bare.name,
      );

      expect(insert[1][3]).toBeNull();
    });

    it("caches a fetched brand logo on the payee", async () => {
      logoService.fetchFavicon.mockResolvedValue({
        data: Buffer.from("icon"),
        contentType: "image/png",
      });

      await service.seedDemoData("user-123");

      const withSite = demoPayees.filter((payee) => payee.website);
      for (const payee of withSite) {
        expect(logoService.fetchFavicon).toHaveBeenCalledWith(payee.website);
      }

      const sample = withSite[0];
      const insert = dataSource.query.mock.calls.find(
        (call: [string, unknown[]]) =>
          call[0].includes("INSERT INTO payees") && call[1][1] === sample.name,
      );
      expect(insert[1]).toEqual(
        expect.arrayContaining([Buffer.from("icon"), "image/png", true]),
      );
    });

    it("seeds a payee whose favicon cannot be fetched with no logo", async () => {
      // The favicon resolver is a third party; an unreachable one leaves the
      // payee on its letter badge rather than failing the seed.
      logoService.fetchFavicon.mockRejectedValue(new Error("offline"));

      await service.seedDemoData("user-123");

      const sample = demoPayees.find((payee) => payee.website) as DemoPayee;
      const insert = dataSource.query.mock.calls.find(
        (call: [string, unknown[]]) =>
          call[0].includes("INSERT INTO payees") && call[1][1] === sample.name,
      );
      expect(insert[1][6]).toBeNull();
      expect(insert[1][8]).toBe(false);
      // The attempt is still stamped: the column records when the favicon was
      // last looked for, and null there would mean it never was.
      expect(insert[1][9]).toEqual(expect.any(String));
    });

    it("seeds transactions including regular, splits, and transfers", async () => {
      await service.seedDemoData("user-123");

      const txCalls = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO transactions"),
      );

      // Should produce a substantial number of transactions
      expect(txCalls.length).toBeGreaterThan(100);
    });

    it("seeds split transactions with transaction_splits", async () => {
      await service.seedDemoData("user-123");

      const splitCalls = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO transaction_splits"),
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

      const priceCalls = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO security_prices"),
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

      const reportCalls = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO custom_reports"),
      );

      expect(reportCalls.length).toBe(demoReports.length);
    });

    it("seeds user preferences", async () => {
      await service.seedDemoData("user-123");

      const prefCalls = dataSource.query.mock.calls.filter((call: string[]) =>
        call[0].includes("INSERT INTO user_preferences"),
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
      const createdAt = new Date(
        firstAccountParams[firstAccountParams.length - 1],
      );
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

    it("posts each mortgage installment as a split whose principal is a transfer leg into the mortgage", async () => {
      // Ids that say what they are, so a leg can be traced to its account.
      dataSource.query.mockImplementation((sql: string, params: unknown[]) => {
        if (sql.includes("INSERT INTO accounts")) {
          return Promise.resolve([{ id: `account-${params[2]}` }]);
        }
        if (sql.includes("INSERT INTO categories")) {
          return Promise.resolve([
            { id: `category-${params[params.length - 1]}` },
          ]);
        }
        if (sql.includes("RETURNING id")) {
          return Promise.resolve([{ id: `uuid-${Math.random()}` }]);
        }
        if (sql.includes("COALESCE(SUM")) {
          return Promise.resolve([{ total: "0" }]);
        }
        return Promise.resolve([]);
      });

      await service.seedDemoData("user-123");

      const calls = dataSource.query.mock.calls as Array<[string, unknown[]]>;
      const transferLegs = calls.filter(
        ([sql]) =>
          sql.includes("INSERT INTO transaction_splits") &&
          sql.includes("'transfer'"),
      );
      expect(transferLegs.length).toBeGreaterThanOrEqual(11);
      for (const [, params] of transferLegs) {
        expect(params[1]).toBe("account-Home Mortgage");
        expect(params[2]).toBeLessThan(0);
        expect(params[3]).toBe("Principal");
      }

      // Each leg's counterpart lands on the mortgage, linked to its parent,
      // for the opposite amount.
      const counterparts = calls.filter(
        ([sql, params]) =>
          sql.includes("INSERT INTO transactions") &&
          sql.includes("linked_transaction_id") &&
          params[1] === "account-Home Mortgage",
      );
      expect(counterparts.map(([, params]) => params[5])).toEqual(
        transferLegs.map(([, params]) => -(params[2] as number)),
      );
      const splitLinks = calls.filter(([sql]) =>
        sql.includes("UPDATE transaction_splits SET linked_transaction_id"),
      );
      expect(splitLinks).toHaveLength(transferLegs.length);

      // The mortgage books its interest to the category the split's other
      // leg uses.
      const mortgageInsert = calls.find(
        ([sql, params]) =>
          sql.includes("INSERT INTO accounts") && params[1] === "MORTGAGE",
      )!;
      const columns = mortgageInsert[0]
        .slice(
          mortgageInsert[0].indexOf("(") + 1,
          mortgageInsert[0].indexOf(")"),
        )
        .split(",")
        .map((column) => column.trim());
      expect(mortgageInsert[1][columns.indexOf("interest_category_id")]).toBe(
        "category-Mortgage Interest",
      );
    });

    it("writes the mortgage type, and the default on every other account", async () => {
      await service.seedDemoData("user-123");

      const accountCalls = dataSource.query.mock.calls.filter(
        (call: string[]) =>
          call[0].includes("INSERT INTO accounts") &&
          call[0].includes("mortgage_type"),
      );
      // The parameter's position follows the INSERT's column list, so it is
      // read from there rather than pinned to a number.
      const columnsOf = (sql: string) =>
        sql
          .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
          .split(",")
          .map((column) => column.trim());
      const typeOf = (call: unknown[]) =>
        (call[1] as unknown[])[
          columnsOf(call[0] as string).indexOf("mortgage_type")
        ];
      const mortgages = accountCalls.filter(
        (call: unknown[]) => (call[1] as unknown[])[1] === "MORTGAGE",
      );

      expect(mortgages.length).toBe(1);
      expect(typeOf(mortgages[0])).toBe("CANADIAN_FIXED");
      for (const call of accountCalls) {
        if (call !== mortgages[0]) {
          // The column is NOT NULL; every non-mortgage row carries ANNUITY.
          expect(typeOf(call)).toBe("ANNUITY");
        }
      }
    });
  });
});
