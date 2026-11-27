import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataQualityReportsService } from "./data-quality-reports.service";
import { RawRateBasis, ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";
import { reportPlacesMock } from "../test-helpers/report-rate-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("DataQualityReportsService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: DataQualityReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let currencyService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    currencyService = {
      getDefaultCurrency: jest.fn().mockResolvedValue("USD"),
      getReportPlaces: reportPlacesMock(),
      // The converter a report builds, per row; a test swaps its body.
      convertRow: jest.fn().mockImplementation((amount: number) => amount),
      buildConverter: jest.fn(),
    };
    currencyService.buildConverter.mockImplementation(
      async () => (amount: number, row: RawRateBasis) =>
        currencyService.convertRow(amount, row),
    );

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([[Transaction, transactionsRepository as never]]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataQualityReportsService,
        {
          provide: ReportCurrencyService,
          useValue: currencyService,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<DataQualityReportsService>(DataQualityReportsService);
  });

  // ---------------------------------------------------------------------------
  // getUncategorizedTransactions
  // ---------------------------------------------------------------------------
  describe("getUncategorizedTransactions", () => {
    it("reads a split's transfer line holding a category as a transfer, not as its category line", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      // Both the list and the summary: a split is categorized only by a
      // category line (INV-CATEGORY-001, INV-REPORT-006).
      const sql = scopedManager.query.mock.calls.map(([text]) => String(text));
      expect(sql).toHaveLength(2);
      for (const text of sql) {
        expect(text).toMatch(
          /FROM transaction_splits ts\s+WHERE ts\.transaction_id = t\.id\s+AND ts\.category_id IS NOT NULL[\s\S]*?AND ts\.transfer_account_id IS NULL/,
        );
      }
    });

    it("leaves a currency's summary out whole when one of its days has no rate (issue #2106)", async () => {
      currencyService.convertRow.mockImplementation(
        (amount: number, row: RawRateBasis) =>
          row.tx_date === "2024-01-05" ? null : amount,
      );
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([
        {
          currency_code: "EUR",
          tx_date: "2025-06-01",
          own_rate: null,
          total_count: "1",
          expense_count: "1",
          expense_total: "100",
          income_count: "0",
          income_total: "0",
        },
        {
          currency_code: "EUR",
          tx_date: "2024-01-05",
          own_rate: null,
          total_count: "1",
          expense_count: "1",
          expense_total: "50",
          income_count: "0",
          income_total: "0",
        },
      ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      expect(result.summary.expenseTotal).toBeNull();
      expect(result.summary.knownExpenseTotal).toBe(0);
      expect(result.summary.totalCount).toBe(2);
    });

    it("returns empty result when no uncategorized transactions exist", async () => {
      // First call: transaction list query
      scopedManager.query.mockResolvedValueOnce([]);
      // Second call: summary query
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions).toEqual([]);
      expect(result.summary).toEqual({
        totalCount: 0,
        expenseCount: 0,
        expenseTotal: 0,
        knownExpenseTotal: 0,
        incomeCount: 0,
        incomeTotal: 0,
        knownIncomeTotal: 0,
        currencyCode: "USD",
      });
    });

    it("returns uncategorized transactions with correct fields", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          currency_code: "USD",
          amount: "-50.00",
          payee_name: "Coffee Shop",
          description: "Morning coffee",
          account_name: "Checking",
          account_id: "acc-1",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-16",
          currency_code: "USD",
          amount: "200.00",
          payee_name: null,
          description: null,
          account_name: "Savings",
          account_id: "acc-2",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([
        {
          currency_code: "USD",
          total_count: "2",
          expense_count: "1",
          expense_total: "50.00",
          income_count: "1",
          income_total: "200.00",
        },
      ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0].id).toBe("tx-1");
      expect(result.transactions[0].amount).toBe(-50);
      expect(result.transactions[0].currencyCode).toBe("USD");
      expect(result.transactions[0].payeeName).toBe("Coffee Shop");
      expect(result.transactions[0].description).toBe("Morning coffee");
      expect(result.transactions[0].accountName).toBe("Checking");
      expect(result.transactions[0].accountId).toBe("acc-1");

      expect(result.transactions[1].payeeName).toBeNull();
      expect(result.transactions[1].description).toBeNull();
      expect(result.transactions[1].accountId).toBe("acc-2");
    });

    it("converts summary currency groups into one explicitly denominated total", async () => {
      currencyService.convertRow.mockImplementation(
        (amount: number, { currency_code: fromCurrency }: RawRateBasis) =>
          fromCurrency === "EUR" ? amount * 1.1 : amount,
      );
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([
        {
          currency_code: "USD",
          total_count: "5",
          expense_count: "3",
          expense_total: "300.00",
          income_count: "2",
          income_total: "1000.00",
        },
        {
          currency_code: "EUR",
          total_count: "3",
          expense_count: "2",
          expense_total: "200.00",
          income_count: "1",
          income_total: "500.00",
        },
      ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.totalCount).toBe(8);
      expect(result.summary.expenseCount).toBe(5);
      expect(result.summary.incomeCount).toBe(3);
      expect(result.summary.expenseTotal).toBe(520);
      expect(result.summary.incomeTotal).toBe(1550);
      expect(result.summary.currencyCode).toBe("USD");
    });

    it("returns a transaction amount in the report currency", async () => {
      currencyService.convertRow.mockImplementation(
        (amount: number, { currency_code: fromCurrency }: RawRateBasis) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: "2025-05-01",
          currency_code: "EUR",
          amount: "-100.00",
          payee_name: "Euro Store",
          description: null,
          account_name: "Euro Account",
          account_id: "acc-1",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions[0].amount).toBeCloseTo(-110, 2);
      expect(result.transactions[0].currencyCode).toBe("USD");
    });

    it("rounds a converted amount once at the report currency's places (issue #2410)", async () => {
      // -1.00 EUR at 2.50498 is -2.50498 USD, sent unrounded until now: it
      // reads -2.50. A row already in USD is its posted amount: 124.7525 and
      // -0.004 stay as stored, so neither reads 124.75 or a zero that the
      // page's income and expense filters would both drop.
      currencyService.convertRow.mockImplementation(
        (amount: number, { currency_code: fromCurrency }: RawRateBasis) =>
          fromCurrency === "EUR" ? amount * 2.50498 : amount,
      );
      const row = (id: string, currency_code: string, amount: string) => ({
        id,
        transaction_date: "2025-05-01",
        currency_code,
        amount,
        payee_name: "Store",
        description: null,
        account_name: "Account",
        account_id: "acc-1",
      });
      scopedManager.query.mockResolvedValueOnce([
        row("tx-1", "EUR", "-1.00"),
        row("tx-2", "USD", "124.7525"),
        row("tx-3", "USD", "-0.004"),
      ]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions.map((t) => t.amount)).toEqual([
        -2.5, 124.7525, -0.004,
      ]);
    });

    it("includes startDate filter when provided", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      const listQueryCall = scopedManager.query.mock.calls[0];
      expect(listQueryCall[1]).toContain("2025-06-01");

      const summaryQueryCall = scopedManager.query.mock.calls[1];
      expect(summaryQueryCall[1]).toContain("2025-06-01");
    });

    it("omits startDate filter when undefined", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const listQueryCall = scopedManager.query.mock.calls[0];
      expect(listQueryCall[0]).not.toContain("transaction_date >= $");
      expect(listQueryCall[1]).toEqual([mockUserId, "2025-12-31", "USD", 500]);
    });

    it("uses custom limit parameter", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
        100,
      );

      const listQueryCall = scopedManager.query.mock.calls[0];
      expect(listQueryCall[1]).toContain(100);
    });

    it("uses default limit of 500", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const listQueryCall = scopedManager.query.mock.calls[0];
      expect(listQueryCall[1]).toContain(500);
    });

    it("rounds summary monetary values to 2 decimal places", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([
        {
          currency_code: "USD",
          total_count: "2",
          expense_count: "1",
          expense_total: "33.337",
          income_count: "1",
          income_total: "66.663",
        },
      ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // USD's two places (issue #2410).
      expect(result.summary.expenseTotal).toBe(33.34);
      expect(result.summary.incomeTotal).toBe(66.66);
    });

    it("formats transaction dates as YYYY-MM-DD", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: "2025-03-15T10:30:00.000Z",
          currency_code: "USD",
          amount: "-25.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
          account_id: "acc-1",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions[0].transactionDate).toBe("2025-03-15");
    });

    it("uses the user's default as the report currency", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildConverter).toHaveBeenCalledWith(
        expect.any(Array),
        "USD",
      );
      expect(result.summary.currencyCode).toBe("USD");
    });

    it("handles both startDate and limit parameters together", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
        50,
      );

      const listQueryCall = scopedManager.query.mock.calls[0];
      // Params: userId, endDate, reporting currency, startDate, limit
      expect(listQueryCall[1]).toEqual([
        mockUserId,
        "2025-12-31",
        "USD",
        "2025-06-01",
        50,
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // A missing exchange rate is unknown, never 1:1 (INV-FX-001)
  // ---------------------------------------------------------------------------
  describe("getUncategorizedTransactions with a currency that has no rate", () => {
    beforeEach(() => {
      currencyService.convertRow.mockImplementation(
        (amount: number, { currency_code: from }: RawRateBasis) =>
          from === "JPY" ? null : amount,
      );
    });

    it("keeps the row with its own amount and currency, never the default's label", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-jpy",
          transaction_date: "2025-05-01",
          currency_code: "JPY",
          amount: "-100000",
          payee_name: "Tokyo Shop",
          description: null,
          account_name: "Yen Account",
          account_id: "acc-1",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amount).toBe(-100000);
      expect(result.transactions[0].currencyCode).toBe("JPY");
    });

    it("withholds the summary totals and keeps the converted subtotal", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([
        {
          currency_code: "USD",
          total_count: "1",
          expense_count: "1",
          expense_total: "50.00",
          income_count: "0",
          income_total: "0",
        },
        {
          currency_code: "JPY",
          total_count: "1",
          expense_count: "1",
          expense_total: "100000",
          income_count: "0",
          income_total: "0",
        },
      ]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.expenseTotal).toBeNull();
      expect(result.summary.incomeTotal).toBeNull();
      expect(result.summary.knownExpenseTotal).toBe(50);
      expect(result.summary.knownIncomeTotal).toBe(0);
      // A count needs no rate: both uncategorized rows still need filing.
      expect(result.summary.totalCount).toBe(2);
      expect(result.summary.expenseCount).toBe(2);
      expect(result.summary.currencyCode).toBe("USD");
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(JSON.stringify(result.summary)).not.toContain("100000");
    });

    it("answers zero, not null, when nothing is uncategorized", async () => {
      scopedManager.query.mockResolvedValueOnce([]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.expenseTotal).toBe(0);
      expect(result.summary.incomeTotal).toBe(0);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getDuplicateTransactions
  // ---------------------------------------------------------------------------
  describe("getDuplicateTransactions", () => {
    it("returns empty result when no transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toEqual([]);
      expect(result.summary).toEqual({
        totalGroups: 0,
        veryHighCount: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        potentialSavings: 0,
        knownPotentialSavings: 0,
      });
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual([]);
    });

    it("converts each group's extra copies into the reporting currency, at the currency's places (issue #2410)", async () => {
      // 100 EUR twice (one extra copy) at 1.1 is 110 USD; 50.005 USD three
      // times (two extra copies) is 100.01. Adding the rows' own amounts made
      // 200.01 of no currency at all. A JPY pair with no rate is left out and
      // named, so the total is withheld beside the part that converted.
      currencyService.convertRow.mockImplementation(
        (amount: number, { currency_code: from }: RawRateBasis) =>
          from === "EUR" ? amount * 1.1 : from === "JPY" ? null : amount,
      );
      const row = (id: string, amount: string, currency: string) => ({
        id,
        transaction_date: "2025-06-15",
        amount,
        currency_code: currency,
        payee_name: `Store ${currency}`,
        description: null,
        account_name: "Checking",
        account_id: "acc-1",
        category_id: null,
        category_name: null,
        is_split: false,
        status: null,
      });
      scopedManager.query.mockResolvedValue([
        row("e1", "-100.00", "EUR"),
        row("e2", "-100.00", "EUR"),
        row("u1", "-50.005", "USD"),
        row("u2", "-50.005", "USD"),
        row("u3", "-50.005", "USD"),
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.potentialSavings).toBe(210.01);
      expect(result.summary.knownPotentialSavings).toBe(210.01);
      expect(result.currency).toBe("USD");

      scopedManager.query.mockResolvedValue([
        row("j1", "-1000", "JPY"),
        row("j2", "-1000", "JPY"),
        row("u1", "-50.005", "USD"),
        row("u2", "-50.005", "USD"),
      ]);
      const partial = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(partial.summary.potentialSavings).toBeNull();
      expect(partial.summary.knownPotentialSavings).toBe(50.01);
      expect(partial.missingCurrencies).toEqual(["JPY"]);
    });

    it("converts each extra copy at its own row's currency, not the group's first (issue #2410)", async () => {
      // 100.00 USD and 100.00 EUR on one day to one payee match as copies.
      // The EUR copy is 110 USD at 1.1, not 100 at the first row's currency.
      currencyService.convertRow.mockImplementation(
        (amount: number, { currency_code: from }: RawRateBasis) =>
          from === "EUR" ? amount * 1.1 : amount,
      );
      const row = (id: string, currency: string) => ({
        id,
        transaction_date: "2025-06-15",
        amount: "-100.00",
        currency_code: currency,
        payee_name: "Store",
        description: null,
        account_name: currency,
        account_id: `acc-${currency}`,
        category_id: null,
        category_name: null,
        is_split: false,
        status: null,
      });
      scopedManager.query.mockResolvedValue([
        row("u1", "USD"),
        row("e1", "EUR"),
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].transactions.map((t) => t.id)).toEqual([
        "u1",
        "e1",
      ]);
      expect(result.summary.potentialSavings).toBe(110);
    });

    it("orders rows that tie on date and amount by id, so a group's first copy is always the same row (issue #2410)", async () => {
      // With copies in two currencies the first row is the one the impact
      // leaves out: on a tie with no further key, 110 or 100 by row order.
      scopedManager.query.mockResolvedValue([]);

      await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(scopedManager.query.mock.calls[0][0]).toMatch(
        /ORDER BY t\.transaction_date ASC, t\.amount ASC, t\.id ASC/,
      );
    });

    it("assigns high confidence when date, amount and payee match but the category differs", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          category_id: "cat-dining",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Coffee Shop",
          description: "Latte",
          account_name: "Checking",
        },
        {
          id: "tx-2",
          category_id: "cat-groceries",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Coffee Shop",
          description: "Latte again",
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].confidence).toBe("high");
      expect(result.groups[0].reason).toBe("Same date, amount, and payee");
      expect(result.groups[0].transactions).toHaveLength(2);
    });

    it("detects duplicates with same date and amount but different payees", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-75.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-75.00",
          payee_name: "Store B",
          description: null,
          account_name: "Savings",
        },
      ]);

      // Default sensitivity is "medium" which checks payees
      // Since payees differ, with medium sensitivity these should still match
      // because checkPayee only skips when BOTH payees exist AND differ
      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "medium",
      );

      // With medium sensitivity, different payees prevent matching
      expect(result.groups).toHaveLength(0);
    });

    it("uses correct maxDaysDiff based on sensitivity", async () => {
      // Two transactions 2 days apart with same amount
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-17",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      // Low sensitivity: maxDaysDiff = 0, should NOT match
      const resultLow = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "low",
      );
      expect(resultLow.groups).toHaveLength(0);

      // Medium sensitivity: maxDaysDiff = 1, should NOT match (2 days apart)
      const resultMedium = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "medium",
      );
      expect(resultMedium.groups).toHaveLength(0);

      // High sensitivity: maxDaysDiff = 3, should match (2 days apart)
      const resultHigh = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "high",
      );
      expect(resultHigh.groups).toHaveLength(1);
    });

    it("does not check payee with low sensitivity", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store B",
          description: null,
          account_name: "Savings",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "low",
      );

      // Low sensitivity: checkPayee is false, so different payees still match
      expect(result.groups).toHaveLength(1);
    });

    it("does not match transactions with different amounts", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-51.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(0);
    });

    it("allows amount difference up to 0.01", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-50.01",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
    });

    it("assigns medium confidence when same payee and amount within days", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-17",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "high",
      );

      expect(result.groups).toHaveLength(1);
      // Different dates but same payee -> medium confidence
      expect(result.groups[0].confidence).toBe("medium");
      expect(result.groups[0].reason).toContain("Same payee and amount");
    });

    it("assigns high confidence when same date, amount, and both payees null", async () => {
      // When both payees are null, normalized to "" which matches, so allSamePayee=true
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          category_id: "cat-dining",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: null,
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          category_id: "cat-groceries",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: null,
          description: null,
          account_name: "Savings",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].confidence).toBe("high");
      expect(result.groups[0].reason).toBe("Same date, amount, and payee");
    });

    it("assigns medium confidence when same date and amount but different payees (low sensitivity)", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store B",
          description: null,
          account_name: "Savings",
        },
      ]);

      // Low sensitivity does not check payee, so different payees still match
      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "low",
      );

      expect(result.groups).toHaveLength(1);
      // Same date but different payees -> allSamePayee is false -> "medium"
      expect(result.groups[0].confidence).toBe("medium");
      expect(result.groups[0].reason).toBe("Same date and amount");
    });

    it("groups more than 2 duplicate transactions together", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-25.00",
          payee_name: "Vending",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-25.00",
          payee_name: "Vending",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-3",
          transaction_date: "2025-06-15",
          amount: "-25.00",
          payee_name: "Vending",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].transactions).toHaveLength(3);
    });

    it("sorts groups by confidence then by amount", async () => {
      scopedManager.query.mockResolvedValue([
        // High confidence pair (same date, amount, payee)
        {
          id: "tx-h1",
          category_id: "cat-dining",
          transaction_date: "2025-06-10",
          amount: "-10.00",
          payee_name: "Small Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-h2",
          category_id: "cat-groceries",
          transaction_date: "2025-06-10",
          amount: "-10.00",
          payee_name: "Small Store",
          description: null,
          account_name: "Checking",
        },
        // Another high confidence pair (same date, amount; null payees match)
        {
          id: "tx-h3",
          category_id: "cat-dining",
          transaction_date: "2025-06-20",
          amount: "-500.00",
          payee_name: null,
          description: null,
          account_name: "Savings",
        },
        {
          id: "tx-h4",
          category_id: "cat-groceries",
          transaction_date: "2025-06-20",
          amount: "-500.00",
          payee_name: null,
          description: null,
          account_name: "Savings",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(2);
      // Both are high confidence; sorted by amount descending within same confidence
      expect(result.groups[0].confidence).toBe("high");
      expect(result.groups[1].confidence).toBe("high");
      expect(
        Math.abs(result.groups[0].transactions[0].amount),
      ).toBeGreaterThanOrEqual(
        Math.abs(result.groups[1].transactions[0].amount),
      );
    });

    it("calculates potentialSavings correctly", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-3",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // 3 transactions, 2 are duplicates -> savings = 100 * 2 = 200
      expect(result.summary.potentialSavings).toBe(200);
    });

    it("counts summary fields correctly", async () => {
      scopedManager.query.mockResolvedValue([
        // High confidence group (same date, amount, payee)
        {
          id: "tx-1",
          category_id: "cat-dining",
          transaction_date: "2025-06-10",
          amount: "-50.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          category_id: "cat-groceries",
          transaction_date: "2025-06-10",
          amount: "-50.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        // Medium confidence group: same payee and amount within days (high sensitivity)
        // We use different dates but same payee to get medium confidence
        {
          id: "tx-3",
          transaction_date: "2025-06-20",
          amount: "-200.00",
          payee_name: "Store B",
          description: null,
          account_name: "Savings",
        },
        {
          id: "tx-4",
          transaction_date: "2025-06-21",
          amount: "-200.00",
          payee_name: "Store B",
          description: null,
          account_name: "Savings",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "medium",
      );

      expect(result.summary.totalGroups).toBe(2);
      expect(result.summary.highCount).toBe(1);
      expect(result.summary.mediumCount).toBe(1);
      expect(result.summary.lowCount).toBe(0);
    });

    it("includes startDate filter when provided", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getDuplicateTransactions(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toContain("2025-06-01");
      expect(queryCall[0]).toContain("$3");
    });

    it("omits startDate filter when undefined", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getDuplicateTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const queryCall = scopedManager.query.mock.calls[0];
      // The reporting currency is bound for the rows' rate basis only.
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "USD"]);
    });

    it("uses default medium sensitivity", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Same Payee",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          // 1 day apart: within maxDaysDiff=1 for medium
          transaction_date: "2025-06-16",
          amount: "-100.00",
          payee_name: "Same Payee",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // Medium sensitivity: maxDaysDiff=1, checkPayee=true
      // 1 day apart + same payee = should match
      expect(result.groups).toHaveLength(1);
    });

    it("does not create a group with only one transaction", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Unique Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(0);
    });

    it("does not match a transaction with itself", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(0);
    });

    it("generates unique group keys from first transaction id and count", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-alpha",
          transaction_date: "2025-06-15",
          amount: "-30.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-beta",
          transaction_date: "2025-06-15",
          amount: "-30.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups[0].key).toBe("tx-alpha-2");
    });

    it("rounds potentialSavings to 2 decimal places", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-33.33",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15",
          amount: "-33.33",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-3",
          transaction_date: "2025-06-15",
          amount: "-33.33",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // 33.33 * 2 duplicates = 66.66
      expect(result.summary.potentialSavings).toBe(66.66);
    });

    it("breaks early when daysDiff exceeds 7 for optimization", async () => {
      // Two transactions with same amount but 10 days apart
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-01",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-12",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        "high",
      );

      // Even with high sensitivity (maxDaysDiff=3), 11 days apart should not match
      expect(result.groups).toHaveLength(0);
    });

    it("formats transaction dates as YYYY-MM-DD in output", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15T10:00:00.000Z",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-15T14:00:00.000Z",
          amount: "-50.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups[0].transactions[0].transactionDate).toBe(
        "2025-06-15",
      );
    });

    it("handles payee name case-insensitively", async () => {
      scopedManager.query.mockResolvedValue([
        {
          id: "tx-1",
          category_id: "cat-dining",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Coffee Shop",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
          category_id: "cat-groceries",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "COFFEE SHOP",
          description: null,
          account_name: "Checking",
        },
      ]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].confidence).toBe("high");
    });
    describe("very high confidence (issue #2234)", () => {
      const row = (overrides: Record<string, unknown>) => ({
        id: "tx",
        transaction_date: "2025-06-15",
        amount: "-42.00",
        currency_code: "CAD",
        account_id: "acct-chequing",
        payee_name: "Grocer",
        description: null,
        account_name: "Checking",
        category_id: "cat-groceries",
        category_name: "Food: Groceries",
        is_split: false,
        status: "UNRECONCILED",
        ...overrides,
      });

      it("assigns very high confidence when date, amount, payee and category all match", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1" }),
          row({ id: "tx-2", status: "CLEARED" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].confidence).toBe("very_high");
        expect(result.groups[0].reasonCode).toBe(
          "same_date_amount_payee_category",
        );
        expect(result.groups[0].reason).toBe(
          "Same account, date, amount, payee, and category",
        );
        expect(result.summary.veryHighCount).toBe(1);
        expect(result.summary.highCount).toBe(0);
        expect(result.groups[0].transactions[1]).toEqual({
          id: "tx-2",
          transactionDate: "2025-06-15",
          amount: -42,
          currencyCode: "CAD",
          accountId: "acct-chequing",
          payeeName: "Grocer",
          description: null,
          accountName: "Checking",
          categoryId: "cat-groceries",
          categoryName: "Food: Groceries",
          isSplit: false,
          status: "CLEARED",
        });
      });

      it("treats two uncategorized rows as a category match", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", category_id: null, category_name: null }),
          row({ id: "tx-2", category_id: null, category_name: null }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups[0].confidence).toBe("very_high");
      });

      it("never ranks split parents very high, since their lines may differ", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", category_id: null, is_split: true }),
          row({ id: "tx-2", category_id: null, is_split: true }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups[0].confidence).toBe("high");
        expect(result.groups[0].transactions[0].isSplit).toBe(true);
      });

      it("drops the whole group to high when one member's category differs", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1" }),
          row({ id: "tx-2" }),
          row({ id: "tx-3", category_id: "cat-dining" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].transactions).toHaveLength(3);
        expect(result.groups[0].confidence).toBe("high");
        expect(result.groups[0].reasonCode).toBe("same_date_amount_payee");
      });

      it("sorts very high groups ahead of a larger high group", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", amount: "-10.00" }),
          row({ id: "tx-2", amount: "-10.00" }),
          row({ id: "tx-3", amount: "-900.00", category_id: "cat-a" }),
          row({ id: "tx-4", amount: "-900.00", category_id: "cat-b" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups.map((g) => g.confidence)).toEqual([
          "very_high",
          "high",
        ]);
      });

      it("ranks a one-cent difference high, never very high", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", amount: "54.20" }),
          row({ id: "tx-2", amount: "54.21" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].confidence).toBe("high");
      });

      it("ranks the same figure in two currencies high, never very high", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", account_id: "acct-usd", currency_code: "USD" }),
          row({ id: "tx-2", account_id: "acct-cad", currency_code: "CAD" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups[0].confidence).toBe("high");
      });

      it("ranks one charge on two accounts high, never very high", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", account_id: "acct-chequing" }),
          row({ id: "tx-2", account_id: "acct-visa", account_name: "Visa" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.groups[0].confidence).toBe("high");
      });

      it("reports the sensitivity's day window and a code for a near-date match", async () => {
        scopedManager.query.mockResolvedValue([
          row({ id: "tx-1", transaction_date: "2025-06-15" }),
          row({ id: "tx-2", transaction_date: "2025-06-17" }),
        ]);

        const result = await service.getDuplicateTransactions(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          "high",
        );

        expect(result.groups[0].confidence).toBe("medium");
        expect(result.groups[0].reasonCode).toBe(
          "same_payee_amount_within_days",
        );
        expect(result.groups[0].windowDays).toBe(3);
      });

      it("joins the category and its parent for the displayed path", async () => {
        scopedManager.query.mockResolvedValue([]);

        await service.getDuplicateTransactions(
          mockUserId,
          undefined,
          "2025-12-31",
        );

        const sql = scopedManager.query.mock.calls[0][0] as string;
        expect(sql).toContain("LEFT JOIN categories c ON c.id = t.category_id");
        expect(sql).toContain("LEFT JOIN categories pc ON pc.id = c.parent_id");
      });
    });
  });
});
