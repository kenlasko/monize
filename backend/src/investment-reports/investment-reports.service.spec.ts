import { NotFoundException } from "@nestjs/common";
import { InvestmentReportsService } from "./investment-reports.service";
import {
  InvestmentGroupBy,
  InvestmentSortDirection,
} from "./entities/investment-report.entity";
import { AccountSubType } from "../accounts/entities/account.entity";
import { ComputedHolding } from "./investment-report-data.service";

function holding(
  over: Partial<ComputedHolding> & { values?: Record<string, unknown> },
): ComputedHolding {
  return {
    accountId: "a1",
    accountName: "Account One",
    securityId: "s1",
    symbol: "AAA",
    securityName: "Alpha",
    currencyCode: "USD",
    exchangeRate: 1,
    values: { symbol: "AAA" },
    ...over,
  } as ComputedHolding;
}

describe("InvestmentReportsService", () => {
  let service: InvestmentReportsService;
  let reportsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let prefRepository: Record<string, jest.Mock>;
  let dataService: Record<string, jest.Mock>;
  let actionHistoryService: Record<string, jest.Mock>;

  beforeEach(() => {
    reportsRepository = {
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve({ id: "r1", ...x })),
      find: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    accountsRepository = {
      find: jest.fn().mockResolvedValue([
        { id: "a1", accountSubType: AccountSubType.INVESTMENT_BROKERAGE },
        { id: "a2", accountSubType: null },
        { id: "cash1", accountSubType: AccountSubType.INVESTMENT_CASH },
      ]),
    };
    prefRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };
    dataService = {
      computeHoldings: jest.fn().mockResolvedValue([]),
      getLatestMarketDay: jest.fn().mockResolvedValue("2024-06-10"),
    };
    actionHistoryService = { record: jest.fn() };
    service = new InvestmentReportsService(
      reportsRepository as any,
      accountsRepository as any,
      prefRepository as any,
      dataService as any,
      actionHistoryService as any,
    );
  });

  describe("create", () => {
    it("stores the configured columns as given and records history", async () => {
      const saved = await service.create("u1", {
        name: "My Report",
        config: { columns: ["marketValue", "gain"] } as any,
      });
      expect(saved.config.columns).toEqual(["marketValue", "gain"]);
      expect(saved.config.sortDirection).toBe(InvestmentSortDirection.ASC);
      expect(saved.config.accountIds).toEqual([]);
      expect(actionHistoryService.record).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({
          entityType: "investment_report",
          action: "create",
        }),
      );
    });

    it("persists the mergeAccounts config flag", async () => {
      const saved = await service.create("u1", {
        name: "My Report",
        config: { columns: ["symbol"], mergeAccounts: true } as any,
      });
      expect(saved.config.mergeAccounts).toBe(true);
    });
  });

  describe("findAll", () => {
    it("lists the user's reports ordered by sort order", async () => {
      reportsRepository.find.mockResolvedValue([{ id: "r1" }]);
      const result = await service.findAll("u1");
      expect(result).toHaveLength(1);
      expect(reportsRepository.find).toHaveBeenCalledWith({
        where: { userId: "u1" },
        order: { sortOrder: "ASC", createdAt: "DESC" },
      });
    });
  });

  describe("findOne", () => {
    it("throws when the report does not belong to the user", async () => {
      reportsRepository.findOne.mockResolvedValue(null);
      await expect(service.findOne("u1", "missing")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("updates every editable field when provided", async () => {
      reportsRepository.findOne.mockResolvedValue({
        id: "r1",
        userId: "u1",
        name: "Old",
        description: null,
        icon: null,
        backgroundColor: null,
        groupBy: InvestmentGroupBy.NONE,
        isFavourite: false,
        sortOrder: 0,
        config: {
          columns: ["symbol"],
          accountIds: [],
          sortColumn: null,
          sortDirection: InvestmentSortDirection.ASC,
          asOfDate: null,
        },
      });
      const saved = await service.update("u1", "r1", {
        name: "New",
        description: "d",
        icon: "i",
        backgroundColor: "#abcdef",
        groupBy: InvestmentGroupBy.ACCOUNT,
        isFavourite: true,
        sortOrder: 3,
        config: { columns: ["symbol", "gain"] } as any,
      });
      expect(saved.name).toBe("New");
      expect(saved.description).toBe("d");
      expect(saved.icon).toBe("i");
      expect(saved.backgroundColor).toBe("#abcdef");
      expect(saved.groupBy).toBe(InvestmentGroupBy.ACCOUNT);
      expect(saved.isFavourite).toBe(true);
      expect(saved.sortOrder).toBe(3);
      expect(saved.config.columns).toEqual(["symbol", "gain"]);
    });

    it("preserves an existing mergeAccounts flag when the update omits it", async () => {
      reportsRepository.findOne.mockResolvedValue({
        id: "r1",
        userId: "u1",
        name: "Old",
        groupBy: InvestmentGroupBy.SYMBOL,
        isFavourite: false,
        sortOrder: 0,
        config: {
          columns: ["symbol"],
          accountIds: [],
          sortColumn: null,
          sortDirection: InvestmentSortDirection.ASC,
          asOfDate: null,
          mergeAccounts: true,
        },
      });
      const saved = await service.update("u1", "r1", {
        config: { columns: ["symbol", "gain"] } as any,
      });
      expect(saved.config.mergeAccounts).toBe(true);
    });

    it("merges provided fields and rebuilds config", async () => {
      reportsRepository.findOne.mockResolvedValue({
        id: "r1",
        userId: "u1",
        name: "Old",
        config: {
          columns: ["symbol"],
          accountIds: [],
          sortColumn: null,
          sortDirection: InvestmentSortDirection.ASC,
          asOfDate: null,
        },
        groupBy: InvestmentGroupBy.NONE,
      });
      const saved = await service.update("u1", "r1", {
        name: "New",
        config: { columns: ["gain", "symbol"], sortColumn: "gain" } as any,
      });
      expect(saved.name).toBe("New");
      expect(saved.config.columns).toEqual(["gain", "symbol"]);
      expect(saved.config.sortColumn).toBe("gain");
    });

    it("preserves existing accountIds/sortColumn/asOfDate when the update omits them", async () => {
      reportsRepository.findOne.mockResolvedValue({
        id: "r1",
        userId: "u1",
        config: {
          columns: ["symbol"],
          accountIds: ["a1", "a2"],
          sortColumn: "marketValue",
          sortDirection: InvestmentSortDirection.DESC,
          asOfDate: "2024-01-01",
          mergeAccounts: true,
        },
      });
      const saved = await service.update("u1", "r1", {
        config: { columns: ["symbol", "gain"] } as any,
      });
      expect(saved.config.accountIds).toEqual(["a1", "a2"]);
      expect(saved.config.sortColumn).toBe("marketValue");
      expect(saved.config.sortDirection).toBe(InvestmentSortDirection.DESC);
      expect(saved.config.asOfDate).toBe("2024-01-01");
      expect(saved.config.mergeAccounts).toBe(true);
    });

    it("clears sortColumn/asOfDate when the update sends an explicit null", async () => {
      reportsRepository.findOne.mockResolvedValue({
        id: "r1",
        userId: "u1",
        config: {
          columns: ["symbol"],
          accountIds: ["a1"],
          sortColumn: "gain",
          asOfDate: "2024-01-01",
        },
      });
      const saved = await service.update("u1", "r1", {
        config: { columns: ["symbol"], sortColumn: null, asOfDate: null } as any,
      });
      expect(saved.config.sortColumn).toBeNull();
      expect(saved.config.asOfDate).toBeNull();
      // accountIds was omitted (undefined), so it stays as-is.
      expect(saved.config.accountIds).toEqual(["a1"]);
    });
  });

  describe("remove", () => {
    it("removes the report and records history", async () => {
      reportsRepository.findOne.mockResolvedValue({
        id: "r1",
        userId: "u1",
        name: "X",
      });
      await service.remove("u1", "r1");
      expect(reportsRepository.remove).toHaveBeenCalled();
      expect(actionHistoryService.record).toHaveBeenCalledWith(
        "u1",
        expect.objectContaining({ action: "delete" }),
      );
    });
  });

  describe("execute", () => {
    const baseReport = {
      id: "r1",
      userId: "u1",
      name: "Report",
      groupBy: InvestmentGroupBy.NONE,
      config: {
        columns: ["marketValue", "symbol"],
        accountIds: [],
        sortColumn: "marketValue",
        sortDirection: InvestmentSortDirection.DESC,
        asOfDate: null,
      },
    };

    it("resolves all holdings accounts, defaults the date, sorts and picks columns", async () => {
      reportsRepository.findOne.mockResolvedValue(baseReport);
      dataService.computeHoldings.mockResolvedValue([
        holding({ symbol: "AAA", values: { symbol: "AAA", marketValue: 100 } }),
        holding({
          symbol: "BBB",
          securityId: "s2",
          values: { symbol: "BBB", marketValue: 200 },
        }),
      ]);

      const result = await service.execute("u1", "r1");

      // Empty accountIds -> all holdings accounts (brokerage + standalone, no cash)
      expect(dataService.computeHoldings).toHaveBeenCalledWith(
        "u1",
        ["a1", "a2"],
        "2024-06-10",
        "USD",
        false,
      );
      expect(result.asOfDate).toBe("2024-06-10");
      expect(result.columns).toEqual(["marketValue", "symbol"]);
      expect(result.groups).toHaveLength(1);
      // DESC by marketValue -> BBB first
      expect(result.groups[0].rows[0].values.symbol).toBe("BBB");
      expect(result.groups[0].rows[1].values.symbol).toBe("AAA");
      expect(result.rowCount).toBe(2);
      // Each row carries its native currency and base-currency conversion rate.
      expect(result.groups[0].rows[0].currency).toBe("USD");
      expect(result.groups[0].rows[0].baseExchangeRate).toBe(1);
    });

    it("honours an as-of date override and restricts requested accounts", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        config: { ...baseReport.config, accountIds: ["a1", "notmine"] },
      });
      await service.execute("u1", "r1", { asOfDate: "2024-01-01" });
      expect(dataService.getLatestMarketDay).not.toHaveBeenCalled();
      expect(dataService.computeHoldings).toHaveBeenCalledWith(
        "u1",
        ["a1"], // "notmine" filtered out
        "2024-01-01",
        "USD",
        false,
      );
    });

    it("prepends the account column when separating securities grouped by symbol", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        groupBy: InvestmentGroupBy.SYMBOL,
      });
      dataService.computeHoldings.mockResolvedValue([
        holding({ symbol: "AAA", values: { symbol: "AAA", marketValue: 100 } }),
      ]);
      const result = await service.execute("u1", "r1");
      expect(result.columns[0]).toBe("account");
      // separated (no merge) -> computeHoldings called with mergeAccounts=false
      expect(dataService.computeHoldings).toHaveBeenCalledWith(
        "u1",
        expect.any(Array),
        "2024-06-10",
        "USD",
        false,
      );
    });

    it("merges across accounts when configured and omits the forced account column", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        groupBy: InvestmentGroupBy.SYMBOL,
        config: { ...baseReport.config, mergeAccounts: true },
      });
      dataService.computeHoldings.mockResolvedValue([
        holding({ symbol: "AAA", values: { symbol: "AAA", marketValue: 100 } }),
      ]);
      const result = await service.execute("u1", "r1");
      expect(dataService.computeHoldings).toHaveBeenCalledWith(
        "u1",
        expect.any(Array),
        "2024-06-10",
        "USD",
        true,
      );
      expect(result.columns[0]).not.toBe("account");
    });

    it("honours merge for no grouping (combine duplicate securities)", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        config: { ...baseReport.config, mergeAccounts: true },
      }); // groupBy NONE
      await service.execute("u1", "r1");
      expect(dataService.computeHoldings).toHaveBeenCalledWith(
        "u1",
        expect.any(Array),
        "2024-06-10",
        "USD",
        true,
      );
    });

    it("ignores merge when grouping by account", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        groupBy: InvestmentGroupBy.ACCOUNT,
        config: { ...baseReport.config, mergeAccounts: true },
      });
      await service.execute("u1", "r1");
      expect(dataService.computeHoldings).toHaveBeenCalledWith(
        "u1",
        expect.any(Array),
        "2024-06-10",
        "USD",
        false, // rows already keyed by account
      );
    });

    it("groups by symbol", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        groupBy: InvestmentGroupBy.SYMBOL,
      });
      dataService.computeHoldings.mockResolvedValue([
        holding({
          symbol: "AAA",
          securityId: "s1",
          values: { symbol: "AAA", marketValue: 100 },
        }),
        holding({
          symbol: "BBB",
          securityId: "s2",
          values: { symbol: "BBB", marketValue: 200 },
        }),
      ]);
      const result = await service.execute("u1", "r1");
      expect(result.groups).toHaveLength(2);
      expect(result.groups.map((g) => g.label)).toEqual(["AAA", "BBB"]);
    });

    it("groups by account and by currency", async () => {
      dataService.computeHoldings.mockResolvedValue([
        holding({ accountId: "a1", accountName: "Acc One", currencyCode: "USD", symbol: "AAA", values: { symbol: "AAA", marketValue: 100 } }),
        holding({ accountId: "a2", accountName: "Acc Two", currencyCode: "CAD", symbol: "BBB", securityId: "s2", values: { symbol: "BBB", marketValue: 200 } }),
      ]);

      reportsRepository.findOne.mockResolvedValue({ ...baseReport, groupBy: InvestmentGroupBy.ACCOUNT });
      const byAccount = await service.execute("u1", "r1");
      expect(byAccount.groups.map((g) => g.label).sort()).toEqual(["Acc One", "Acc Two"]);

      reportsRepository.findOne.mockResolvedValue({ ...baseReport, groupBy: InvestmentGroupBy.CURRENCY });
      const byCurrency = await service.execute("u1", "r1");
      expect(byCurrency.groups.map((g) => g.label).sort()).toEqual(["CAD", "USD"]);
    });

    it("defaults to sorting by symbol when no sort column is set", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        config: { ...baseReport.config, sortColumn: null, sortDirection: InvestmentSortDirection.ASC },
      });
      dataService.computeHoldings.mockResolvedValue([
        holding({ symbol: "ZZZ", securityId: "s2", values: { symbol: "ZZZ" } }),
        holding({ symbol: "AAA", values: { symbol: "AAA" } }),
      ]);
      const result = await service.execute("u1", "r1");
      expect(result.groups[0].rows.map((r) => r.values.symbol)).toEqual(["AAA", "ZZZ"]);
    });

    it("sorts nulls last regardless of direction", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...baseReport,
        config: {
          ...baseReport.config,
          sortColumn: "gain",
          sortDirection: InvestmentSortDirection.DESC,
        },
      });
      dataService.computeHoldings.mockResolvedValue([
        holding({ symbol: "AAA", values: { symbol: "AAA", gain: null } }),
        holding({
          symbol: "BBB",
          securityId: "s2",
          values: { symbol: "BBB", gain: 5 },
        }),
      ]);
      const result = await service.execute("u1", "r1");
      expect(result.groups[0].rows[0].values.symbol).toBe("BBB"); // non-null first
      expect(result.groups[0].rows[1].values.symbol).toBe("AAA"); // null last
    });
  });
});
