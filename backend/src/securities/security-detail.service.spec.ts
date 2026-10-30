import { Test, TestingModule } from "@nestjs/testing";
import { SecurityDetailService } from "./security-detail.service";
import { SecuritiesService } from "./securities.service";
import { PortfolioService } from "./portfolio.service";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import { InvestmentAction } from "./entities/investment-transaction.entity";
import { TransactionStatus } from "../transactions/entities/transaction-status.enum";

const SECURITY_ID = "sec-1";
const USER_ID = "user-1";

/** A holding row as `PortfolioService` produces it, with test overrides. */
function holding(overrides: Record<string, unknown> = {}) {
  return {
    id: "holding-1",
    accountId: "acct-1",
    securityId: SECURITY_ID,
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    currencyCode: "USD",
    quantity: 60,
    averageCost: 100,
    costBasis: 6000,
    costBasisAccountCurrency: 24000,
    currentPrice: 120,
    marketValue: 7200,
    gainLoss: 1200,
    gainLossPercent: 20,
    ...overrides,
  };
}

function historyTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: "tx-1",
    transactionDate: "2024-01-15",
    accountId: "acct-1",
    accountName: "Brokerage",
    action: InvestmentAction.BUY,
    quantity: 60,
    price: 100,
    commission: 5,
    totalAmount: 6005,
    description: null,
    linkedTransactionId: null,
    status: TransactionStatus.CLEARED,
    runningQuantityAccount: 60,
    runningQuantityAll: 60,
    ...overrides,
  };
}

/** One account in the transaction history's "where it is held" list. */
function historyAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "acct-1",
    accountName: "Brokerage",
    isClosed: false,
    currentQuantity: 60,
    ...overrides,
  };
}

describe("SecurityDetailService", () => {
  let service: SecurityDetailService;
  let securitiesService: Record<string, jest.Mock>;
  let portfolioService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;

  const security = {
    id: SECURITY_ID,
    userId: USER_ID,
    symbol: "AAPL",
    name: "Apple Inc.",
    currencyCode: "USD",
    isActive: true,
  };

  /** Wires the two data sources so a test only states what it cares about. */
  function given(options: {
    historyAccounts?: Record<string, unknown>[];
    transactions?: Record<string, unknown>[];
    currentQuantityAll?: number;
    holdingsByAccount?: Record<string, unknown>[];
    holdings?: Record<string, unknown>[];
  }) {
    const accounts: Record<string, unknown>[] = options.historyAccounts ?? [
      historyAccount(),
    ];
    const transactions: Record<string, unknown>[] = options.transactions ?? [
      historyTransaction(),
    ];
    investmentTransactionsService.getSecurityTransactionHistory.mockResolvedValue(
      {
        securityId: SECURITY_ID,
        symbol: "AAPL",
        name: "Apple Inc.",
        currencyCode: "USD",
        isActive: true,
        accounts,
        transactions,
        currentQuantityAll:
          options.currentQuantityAll ??
          accounts
            .map((a) => (a.currentQuantity as number) ?? 0)
            .reduce((sum, quantity) => sum + quantity, 0),
      },
    );
    portfolioService.getPortfolioSummary.mockResolvedValue({
      holdings: options.holdings ?? [holding()],
      holdingsByAccount: options.holdingsByAccount ?? [
        {
          accountId: "acct-1",
          accountName: "Brokerage",
          currencyCode: "PLN",
          holdings: [holding()],
        },
      ],
    });
  }

  const getDetail = () => service.getDetail(USER_ID, SECURITY_ID);

  beforeEach(async () => {
    securitiesService = {
      findOne: jest.fn().mockResolvedValue(security),
      getDailyPriceChange: jest.fn().mockResolvedValue(null),
    };
    portfolioService = { getPortfolioSummary: jest.fn() };
    investmentTransactionsService = {
      getSecurityTransactionHistory: jest.fn(),
      getRealizedGains: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityDetailService,
        { provide: SecuritiesService, useValue: securitiesService },
        { provide: PortfolioService, useValue: portfolioService },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
      ],
    }).compile();

    service = module.get<SecurityDetailService>(SecurityDetailService);
    given({});
  });

  it("validates ownership through SecuritiesService", async () => {
    await getDetail();
    expect(securitiesService.findOne).toHaveBeenCalledWith(
      USER_ID,
      SECURITY_ID,
    );
  });

  it("returns the daily change the securities service resolved, and null on refusal", async () => {
    const change = {
      currentPrice: 110,
      previousPrice: 100,
      dailyChange: 10,
      dailyChangePercent: 10,
      priceDate: "2026-02-09",
    };
    securitiesService.getDailyPriceChange.mockResolvedValue(change);
    expect((await getDetail()).dailyChange).toEqual(change);
    expect(securitiesService.getDailyPriceChange).toHaveBeenCalledWith(
      SECURITY_ID,
    );

    securitiesService.getDailyPriceChange.mockResolvedValue(null);
    expect((await getDetail()).dailyChange).toBeNull();
  });

  it("propagates a not-found security instead of returning an empty detail", async () => {
    securitiesService.findOne.mockRejectedValue(new Error("not found"));
    await expect(getDetail()).rejects.toThrow("not found");
  });

  describe("per-account positions", () => {
    it("reuses the portfolio's cost basis and market value verbatim", async () => {
      const detail = await getDetail();

      expect(detail.accounts).toHaveLength(1);
      expect(detail.accounts[0]).toEqual({
        accountId: "acct-1",
        accountName: "Brokerage",
        accountCurrencyCode: "PLN",
        isClosed: false,
        quantity: 60,
        averageCost: 100,
        costBasis: 6000,
        costBasisAccountCurrency: 24000,
        marketValue: 7200,
        gainLoss: 1200,
        gainLossPercent: 20,
      });
    });

    it("takes the share balance from the history, not from the holding row", async () => {
      // The two disagree when the portfolio's snapshot is stale; the history is
      // replayed from the transactions and is the exact figure.
      given({ historyAccounts: [historyAccount({ currentQuantity: 61.5 })] });
      const detail = await getDetail();
      expect(detail.accounts[0].quantity).toBe(61.5);
    });

    it("lists an account the user has closed but still holds shares in", async () => {
      // The portfolio summary is built from open accounts only, so this holding
      // appears in no `holdingsByAccount` group.
      given({
        historyAccounts: [
          historyAccount({
            accountId: "acct-closed",
            accountName: "Old broker",
            isClosed: true,
            currentQuantity: 25,
          }),
        ],
        holdingsByAccount: [],
        holdings: [],
      });

      const detail = await getDetail();
      expect(detail.accounts).toHaveLength(1);
      expect(detail.accounts[0]).toMatchObject({
        accountName: "Old broker",
        isClosed: true,
        quantity: 25,
      });
      // Nothing is known about its value, and nothing is invented.
      expect(detail.accounts[0].costBasis).toBeNull();
      expect(detail.accounts[0].marketValue).toBeNull();
      expect(detail.accounts[0].accountCurrencyCode).toBeNull();
    });

    it("drops accounts that traded the security but hold none of it now", async () => {
      given({
        historyAccounts: [
          historyAccount(),
          historyAccount({
            accountId: "acct-sold-out",
            accountName: "Sold out",
            currentQuantity: 0,
          }),
        ],
      });

      const detail = await getDetail();
      expect(detail.accounts.map((a) => a.accountId)).toEqual(["acct-1"]);
    });

    it("leaves account money null when the security has no price", async () => {
      const priceless = holding({
        currentPrice: null,
        marketValue: null,
        gainLoss: null,
        gainLossPercent: null,
      });
      given({
        holdings: [priceless],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [priceless],
          },
        ],
      });

      const detail = await getDetail();
      expect(detail.accounts[0].marketValue).toBeNull();
      expect(detail.accounts[0].gainLoss).toBeNull();
      // Cost basis does not depend on a price, so it survives.
      expect(detail.accounts[0].costBasis).toBe(6000);
    });

    it("ignores accounts holding other securities", async () => {
      given({
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [holding()],
          },
          {
            accountId: "acct-9",
            accountName: "Other",
            currencyCode: "PLN",
            holdings: [holding({ securityId: "sec-other" })],
          },
        ],
      });

      const detail = await getDetail();
      expect(detail.accounts.map((a) => a.accountId)).toEqual(["acct-1"]);
    });
  });

  describe("aggregate position", () => {
    /** Same security in two accounts: 60 at 100, 40 at 150. */
    function givenTwoAccounts(secondOverrides: Record<string, unknown> = {}) {
      const first = holding();
      const second = holding({
        id: "holding-2",
        accountId: "acct-2",
        quantity: 40,
        averageCost: 150,
        costBasis: 6000,
        costBasisAccountCurrency: 25000,
        marketValue: 4800,
        gainLoss: -1200,
        gainLossPercent: -20,
        ...secondOverrides,
      });
      given({
        historyAccounts: [
          historyAccount(),
          historyAccount({
            accountId: "acct-2",
            accountName: "IKE",
            currentQuantity: 40,
          }),
        ],
        holdings: [first, second],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [first],
          },
          {
            accountId: "acct-2",
            accountName: "IKE",
            currencyCode: "PLN",
            holdings: [second],
          },
        ],
      });
    }

    it("sums quantity, cost basis and market value across accounts", async () => {
      givenTwoAccounts();
      const { position } = await getDetail();
      expect(position.quantity).toBe(100);
      expect(position.costBasis).toBe(12000);
      expect(position.marketValue).toBe(12000);
    });

    it("weights average cost by units rather than averaging the averages", async () => {
      givenTwoAccounts();
      const { position } = await getDetail();
      // 12000 total cost / 100 units = 120, not the (100 + 150) / 2 = 125 that
      // averaging the two per-account averages would give.
      expect(position.averageCost).toBe(120);
    });

    it("keeps a sub-cent average cost instead of rounding it away", async () => {
      // A crypto or penny holding: 15,000 units at 0.00012345678. Rounded to the
      // six places prices used to be stored at, the average cost becomes
      // 0.000123 and the position's cost basis is out by nearly half a percent
      // -- an error proportional to the position, not a rounding artefact.
      const dust = holding({
        quantity: 15000,
        averageCost: 0.00012345678,
        costBasis: 1.8518517,
        marketValue: 2,
        gainLoss: 0.1481483,
      });
      given({
        historyAccounts: [historyAccount({ currentQuantity: 15000 })],
        currentQuantityAll: 15000,
        holdings: [dust],
        holdingsByAccount: [
          {
            accountId: "acct-1",
            accountName: "Brokerage",
            currencyCode: "PLN",
            holdings: [dust],
          },
        ],
      });

      const { position } = await getDetail();
      expect(position.averageCost).toBeCloseTo(0.00012345678, 10);
      // Not the 0.000123 a six-place round would leave, which would be a
      // different number at this magnitude rather than the same one rounded.
      expect(position.averageCost).not.toBe(0.000123);
    });

    it("keeps the gain and its percentage in agreement", async () => {
      givenTwoAccounts();
      const { position } = await getDetail();
      // Both derive from the same security-currency figures, so their signs can
      // never contradict each other the way a converted amount could.
      expect(position.gainLoss).toBe(0);
      expect(position.gainLossPercent).toBe(0);
    });

    it("nulls the total when any account is missing a price", async () => {
      givenTwoAccounts({
        currentPrice: null,
        marketValue: null,
        gainLoss: null,
      });
      const { position } = await getDetail();
      // A partial total would read as a real (and wrong) portfolio value.
      expect(position.marketValue).toBeNull();
      expect(position.gainLoss).toBeNull();
      expect(position.gainLossPercent).toBeNull();
      // Cost basis is still complete, so it is still reported.
      expect(position.costBasis).toBe(12000);
    });

    it("nulls the cost total when a holding in a closed account has no cost data", async () => {
      given({
        historyAccounts: [
          historyAccount(),
          historyAccount({
            accountId: "acct-closed",
            accountName: "Old broker",
            isClosed: true,
            currentQuantity: 40,
          }),
        ],
      });

      const { position } = await getDetail();
      // The exact quantity is still known from the history...
      expect(position.quantity).toBe(100);
      // ...but a cost basis covering only 60 of those 100 units is not a total.
      expect(position.costBasis).toBeNull();
      expect(position.averageCost).toBeNull();
      expect(position.marketValue).toBeNull();
    });

    it("reports the exact quantity for a dust position the portfolio filtered out", async () => {
      // The portfolio calculation skips holdings under 0.0001 units, so this
      // residual reaches us with no holding row at all.
      given({
        historyAccounts: [historyAccount({ currentQuantity: 0.00005 })],
        holdingsByAccount: [],
        holdings: [],
        currentQuantityAll: 0.00005,
      });

      const detail = await getDetail();
      expect(detail.position.quantity).toBe(0.00005);
      // Still held, so emphatically not a closed position.
      expect(detail.isPositionClosed).toBe(false);
      expect(detail.accounts).toHaveLength(1);
    });
  });

  describe("activity totals", () => {
    beforeEach(() => {
      given({
        transactions: [
          historyTransaction({
            id: "tx-1",
            transactionDate: "2022-03-12",
            action: InvestmentAction.BUY,
            quantity: 60,
            price: 100,
            commission: 5,
            totalAmount: 6005,
          }),
          historyTransaction({
            id: "tx-2",
            transactionDate: "2023-06-01",
            action: InvestmentAction.DIVIDEND,
            quantity: null,
            price: null,
            commission: 0,
            totalAmount: 120.5,
          }),
          historyTransaction({
            id: "tx-3",
            transactionDate: "2024-02-02",
            action: InvestmentAction.SELL,
            quantity: 20,
            price: 125,
            commission: 3,
            totalAmount: 2497,
          }),
          historyTransaction({
            id: "tx-4",
            transactionDate: "2026-06-20",
            action: InvestmentAction.INTEREST,
            quantity: null,
            price: null,
            commission: 0,
            totalAmount: 10.25,
          }),
        ],
      });
    });

    it("separates invested, sold, income and fees by action", async () => {
      const { activity } = await getDetail();

      // Stored total, commission included: 6,005, not 60 x 100.
      expect(activity.totalInvested).toBe(6005);
      expect(activity.totalSold).toBe(2497);
      // Dividend plus interest; both are income, not a change of position.
      expect(activity.dividends).toBe(130.75);
      expect(activity.fees).toBe(8);
      expect(activity.transactionCount).toBe(4);
    });

    it("counts reinvestments and transfers in as invested", async () => {
      // Both carry a zero `totalAmount` but do add shares and cost basis, so
      // summing `totalAmount` would report nothing invested for a DRIP holding.
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.REINVEST,
            quantity: 2,
            price: 50,
            totalAmount: 0,
            commission: 0,
          }),
          historyTransaction({
            id: "tx-2",
            action: InvestmentAction.TRANSFER_IN,
            quantity: 10,
            price: 30,
            totalAmount: 0,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.totalInvested).toBe(400);
    });

    it("adds nothing for a paired transfer, priced or not", async () => {
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.BUY,
            quantity: 10,
            price: 100,
            totalAmount: 1010,
            commission: 10,
          }),
          historyTransaction({
            id: "tx-out",
            linkedTransactionId: "tx-in",
            action: InvestmentAction.TRANSFER_OUT,
            quantity: 10,
            price: null,
            totalAmount: 0,
            commission: 0,
          }),
          historyTransaction({
            id: "tx-in",
            linkedTransactionId: "tx-out",
            action: InvestmentAction.TRANSFER_IN,
            quantity: 10,
            price: null,
            totalAmount: 0,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.totalInvested).toBe(1010);
    });

    it("reports invested capital as unknown for an unpaired transfer in with no cost", async () => {
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.TRANSFER_IN,
            quantity: 10,
            price: null,
            totalAmount: 0,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.totalInvested).toBeNull();
    });

    it("reports invested capital as unknown when an acquisition has no price", async () => {
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.BUY,
            quantity: 10,
            price: null,
            totalAmount: 0,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.totalInvested).toBeNull();
    });

    it("counts a reinvested distribution as income at its shares' cost", async () => {
      // Discussion #1670: the reinvested shares are in the cost basis the card
      // sets this figure against, so without their income a DRIP holding's
      // distributions read as no return at all.
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.REINVEST,
            quantity: 2,
            price: 50,
            totalAmount: 0,
            commission: 0,
          }),
          historyTransaction({
            id: "tx-2",
            action: InvestmentAction.REINVEST_INTEREST,
            quantity: 1,
            price: 12.5,
            totalAmount: 0,
            commission: 0,
          }),
          historyTransaction({
            id: "tx-3",
            action: InvestmentAction.TRANSFER_IN,
            quantity: 10,
            price: 30,
            totalAmount: 0,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.dividends).toBe(112.5);
    });

    it("leaves a VOID row out of every money total, though it stays a record", async () => {
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.DIVIDEND,
            totalAmount: 40,
            commission: 0,
          }),
          historyTransaction({
            id: "tx-void",
            action: InvestmentAction.DIVIDEND,
            status: TransactionStatus.VOID,
            totalAmount: 500,
            commission: 9,
          }),
          historyTransaction({
            id: "tx-void-buy",
            action: InvestmentAction.BUY,
            status: TransactionStatus.VOID,
            quantity: 10,
            price: 100,
            totalAmount: 1000,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.dividends).toBe(40);
      expect(activity.fees).toBe(0);
      expect(activity.totalInvested).toBe(0);
      expect(activity.transactionCount).toBe(3);
    });

    it("takes the first and last dates from the ordered history", async () => {
      const { activity } = await getDetail();
      expect(activity.firstTransactionDate).toBe("2022-03-12");
      expect(activity.lastTransactionDate).toBe("2026-06-20");
    });

    it("sums money in integer units so repeated decimals do not drift", async () => {
      given({
        transactions: [
          historyTransaction({
            action: InvestmentAction.DIVIDEND,
            totalAmount: 0.1,
            commission: 0,
          }),
          historyTransaction({
            id: "tx-2",
            action: InvestmentAction.DIVIDEND,
            totalAmount: 0.2,
            commission: 0,
          }),
        ],
      });

      const { activity } = await getDetail();
      expect(activity.dividends).toBe(0.3);
    });
  });

  describe("realized gain", () => {
    it("keeps only this security's gains, labelled with their currency", async () => {
      investmentTransactionsService.getRealizedGains.mockResolvedValue([
        {
          securityId: SECURITY_ID,
          realizedGain: 1000,
          accountCurrencyCode: "PLN",
        },
        {
          securityId: "sec-other",
          realizedGain: 9999,
          accountCurrencyCode: "PLN",
        },
        {
          securityId: SECURITY_ID,
          realizedGain: -250.5,
          accountCurrencyCode: "PLN",
        },
      ]);

      const { activity } = await getDetail();
      expect(activity.realizedGain).toBe(749.5);
      // The replay denominates gains in the holding account's currency, not the
      // security's, so the page has to be told which one it got.
      expect(activity.realizedGainCurrency).toBe("PLN");
    });

    it("refuses to add gains realized in different currencies", async () => {
      investmentTransactionsService.getRealizedGains.mockResolvedValue([
        {
          securityId: SECURITY_ID,
          realizedGain: 1000,
          accountCurrencyCode: "PLN",
        },
        {
          securityId: SECURITY_ID,
          realizedGain: 200,
          accountCurrencyCode: "EUR",
        },
      ]);

      const { activity } = await getDetail();
      // 1200 of neither currency would be worse than saying nothing.
      expect(activity.realizedGain).toBeNull();
      expect(activity.realizedGainCurrency).toBeNull();
      // ...but the sales happened, and the page must be able to say so instead
      // of rendering the same blank it uses for "never sold".
      expect(activity.realizedSaleCount).toBe(2);
      expect(activity.realizedGainCurrencies).toEqual(["EUR", "PLN"]);
    });

    it("does not total gains when one sale's gain is unknown, and names the known part", async () => {
      investmentTransactionsService.getRealizedGains.mockResolvedValue([
        {
          securityId: SECURITY_ID,
          realizedGain: 1000,
          accountCurrencyCode: "PLN",
        },
        {
          securityId: SECURITY_ID,
          realizedGain: null,
          accountCurrencyCode: "PLN",
        },
      ]);

      const { activity } = await getDetail();
      expect(activity.realizedGain).toBeNull();
      expect(activity.realizedGainComplete).toBe(false);
      expect(activity.realizedGainKnownSubtotal).toBe(1000);
      expect(activity.realizedGainCurrency).toBe("PLN");
      expect(activity.realizedSaleCount).toBe(2);
    });

    it("reports nothing when the security was never sold", async () => {
      const { activity } = await getDetail();
      expect(activity.realizedGain).toBeNull();
      expect(activity.realizedGainCurrency).toBeNull();
      // Zero sales is what tells this case apart from the multi-currency one.
      expect(activity.realizedSaleCount).toBe(0);
      expect(activity.realizedGainCurrencies).toEqual([]);
    });

    it("counts a sale from an account with no currency without naming one", async () => {
      investmentTransactionsService.getRealizedGains.mockResolvedValue([
        {
          securityId: SECURITY_ID,
          realizedGain: 40,
          accountCurrencyCode: null,
        },
      ]);

      const { activity } = await getDetail();
      // Unattributable to a currency, so not addable -- but still a sale, and
      // reporting zero sales here would deny it happened.
      expect(activity.realizedGain).toBeNull();
      expect(activity.realizedGainCurrency).toBeNull();
      expect(activity.realizedSaleCount).toBe(1);
      expect(activity.realizedGainCurrencies).toEqual([]);
    });

    it("scopes the replay to the accounts that traded it", async () => {
      await getDetail();
      expect(
        investmentTransactionsService.getRealizedGains,
      ).toHaveBeenCalledWith(USER_ID, { accountIds: ["acct-1"] });
    });
  });

  describe("position state", () => {
    it("marks a held position as neither closed nor empty", async () => {
      const detail = await getDetail();
      expect(detail.hasTransactions).toBe(true);
      expect(detail.isPositionClosed).toBe(false);
    });

    it("marks a fully sold position as closed", async () => {
      given({
        historyAccounts: [historyAccount({ currentQuantity: 0 })],
        holdingsByAccount: [],
        holdings: [],
        currentQuantityAll: 0,
      });

      const detail = await getDetail();
      expect(detail.hasTransactions).toBe(true);
      expect(detail.isPositionClosed).toBe(true);
      expect(detail.accounts).toHaveLength(0);
      expect(detail.position.quantity).toBe(0);
      // No holdings at all is "unknown", not "worth zero".
      expect(detail.position.marketValue).toBeNull();
      expect(detail.position.averageCost).toBeNull();
    });

    it("does not call a never-traded security a closed position", async () => {
      given({
        historyAccounts: [],
        transactions: [],
        holdingsByAccount: [],
        holdings: [],
        currentQuantityAll: 0,
      });

      const detail = await getDetail();
      expect(detail.hasTransactions).toBe(false);
      expect(detail.isPositionClosed).toBe(false);
      expect(detail.activity.firstTransactionDate).toBeNull();
      expect(detail.activity.realizedGain).toBeNull();
      // With no accounts to scope to, the replay is skipped entirely.
      expect(
        investmentTransactionsService.getRealizedGains,
      ).not.toHaveBeenCalled();
    });
  });
});
