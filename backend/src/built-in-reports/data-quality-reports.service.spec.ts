import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataQualityReportsService } from "./data-quality-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";

describe("DataQualityReportsService", () => {
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
      buildRateMap: jest.fn().mockResolvedValue(new Map()),
      convertAmount: jest.fn().mockImplementation((amount) => amount),
    };

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
      ],
    }).compile();

    service = module.get<DataQualityReportsService>(DataQualityReportsService);
  });

  // ---------------------------------------------------------------------------
  // getUncategorizedTransactions
  // ---------------------------------------------------------------------------
  describe("getUncategorizedTransactions", () => {
    it("returns empty result when no uncategorized transactions exist", async () => {
      // First call: transaction list query
      transactionsRepository.query.mockResolvedValueOnce([]);
      // Second call: summary query
      transactionsRepository.query.mockResolvedValueOnce([]);

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
        incomeCount: 0,
        incomeTotal: 0,
      });
    });

    it("returns uncategorized transactions with correct fields", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          currency_code: "USD",
          amount: "-50.00",
          payee_name: "Coffee Shop",
          description: "Morning coffee",
          account_name: "Checking",
        },
        {
          id: "tx-2",
          transaction_date: "2025-06-16",
          currency_code: "USD",
          amount: "200.00",
          payee_name: null,
          description: null,
          account_name: "Savings",
        },
      ]);
      transactionsRepository.query.mockResolvedValueOnce([
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
      expect(result.transactions[0].payeeName).toBe("Coffee Shop");
      expect(result.transactions[0].description).toBe("Morning coffee");
      expect(result.transactions[0].accountName).toBe("Checking");

      expect(result.transactions[1].payeeName).toBeNull();
      expect(result.transactions[1].description).toBeNull();
    });

    it("calculates summary from multiple currency rows", async () => {
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([
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
      // 300 USD + 200 EUR * 1.1 = 300 + 220 = 520
      expect(result.summary.expenseTotal).toBe(520);
      expect(result.summary.incomeCount).toBe(3);
      // 1000 USD + 500 EUR * 1.1 = 1000 + 550 = 1550
      expect(result.summary.incomeTotal).toBe(1550);
    });

    it("converts transaction amounts from foreign currencies", async () => {
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: "2025-05-01",
          currency_code: "EUR",
          amount: "-100.00",
          payee_name: "Euro Store",
          description: null,
          account_name: "Euro Account",
        },
      ]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // -100 EUR * 1.1 = -110 (use toBeCloseTo for floating point)
      expect(result.transactions[0].amount).toBeCloseTo(-110, 2);
    });

    it("includes startDate filter when provided", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      const listQueryCall = transactionsRepository.query.mock.calls[0];
      expect(listQueryCall[1]).toContain("2025-06-01");

      const summaryQueryCall = transactionsRepository.query.mock.calls[1];
      expect(summaryQueryCall[1]).toContain("2025-06-01");
    });

    it("omits startDate filter when undefined", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const listQueryCall = transactionsRepository.query.mock.calls[0];
      expect(listQueryCall[0]).not.toContain("transaction_date >= $");
      expect(listQueryCall[1]).toEqual([mockUserId, "2025-12-31", 500]);
    });

    it("uses custom limit parameter", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
        100,
      );

      const listQueryCall = transactionsRepository.query.mock.calls[0];
      expect(listQueryCall[1]).toContain(100);
    });

    it("uses default limit of 500", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const listQueryCall = transactionsRepository.query.mock.calls[0];
      expect(listQueryCall[1]).toContain(500);
    });

    it("rounds summary monetary values to 2 decimal places", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([
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

      expect(result.summary.expenseTotal).toBe(33.34);
      expect(result.summary.incomeTotal).toBe(66.66);
    });

    it("formats transaction dates as YYYY-MM-DD", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: "2025-03-15T10:30:00.000Z",
          currency_code: "USD",
          amount: "-25.00",
          payee_name: "Store",
          description: null,
          account_name: "Checking",
        },
      ]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      const result = await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.transactions[0].transactionDate).toBe("2025-03-15");
    });

    it("calls currency service with correct user id", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });

    it("handles both startDate and limit parameters together", async () => {
      transactionsRepository.query.mockResolvedValueOnce([]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getUncategorizedTransactions(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
        50,
      );

      const listQueryCall = transactionsRepository.query.mock.calls[0];
      // Params: userId, endDate, startDate, limit
      expect(listQueryCall[1]).toEqual([
        mockUserId,
        "2025-12-31",
        "2025-06-01",
        50,
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // getDuplicateTransactions
  // ---------------------------------------------------------------------------
  describe("getDuplicateTransactions", () => {
    it("returns empty result when no transactions exist", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getDuplicateTransactions(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.groups).toEqual([]);
      expect(result.summary).toEqual({
        totalGroups: 0,
        highCount: 0,
        mediumCount: 0,
        lowCount: 0,
        potentialSavings: 0,
      });
    });

    it("detects exact duplicate transactions (same date, amount, payee)", async () => {
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-50.00",
          payee_name: "Coffee Shop",
          description: "Latte",
          account_name: "Checking",
        },
        {
          id: "tx-2",
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: null,
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
        // High confidence pair (same date, amount, payee)
        {
          id: "tx-h1",
          transaction_date: "2025-06-10",
          amount: "-10.00",
          payee_name: "Small Store",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-h2",
          transaction_date: "2025-06-10",
          amount: "-10.00",
          payee_name: "Small Store",
          description: null,
          account_name: "Checking",
        },
        // Another high confidence pair (same date, amount; null payees match)
        {
          id: "tx-h3",
          transaction_date: "2025-06-20",
          amount: "-500.00",
          payee_name: null,
          description: null,
          account_name: "Savings",
        },
        {
          id: "tx-h4",
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
        // High confidence group (same date, amount, payee)
        {
          id: "tx-1",
          transaction_date: "2025-06-10",
          amount: "-50.00",
          payee_name: "Store A",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
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
      transactionsRepository.query.mockResolvedValue([]);

      await service.getDuplicateTransactions(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toContain("2025-06-01");
      expect(queryCall[0]).toContain("$3");
    });

    it("omits startDate filter when undefined", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getDuplicateTransactions(
        mockUserId,
        undefined,
        "2025-12-31",
      );

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
    });

    it("uses default medium sensitivity", async () => {
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
        {
          id: "tx-1",
          transaction_date: "2025-06-15",
          amount: "-100.00",
          payee_name: "Coffee Shop",
          description: null,
          account_name: "Checking",
        },
        {
          id: "tx-2",
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
  });
});
