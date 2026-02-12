import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportContext } from "./import-context";
import {
  InvestmentAction,
  InvestmentTransaction,
} from "../securities/entities/investment-transaction.entity";
import { AccountSubType } from "../accounts/entities/account.entity";
import { TransactionStatus } from "../transactions/entities/transaction.entity";
import { Security } from "../securities/entities/security.entity";
import { Holding } from "../securities/entities/holding.entity";
import { ImportResultDto } from "./dto/import.dto";

describe("ImportInvestmentProcessorService", () => {
  let service: ImportInvestmentProcessorService;

  const userId = "user-1";
  const accountId = "acc-1";

  const makeImportResult = (): ImportResultDto => ({
    imported: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
    categoriesCreated: 0,
    accountsCreated: 0,
    payeesCreated: 0,
    securitiesCreated: 0,
  });

  const makeMockManager = () => ({
    save: jest.fn().mockImplementation((entity: any) => {
      if (!entity.id) {
        entity.id = `gen-${Date.now()}-${Math.random()}`;
      }
      return Promise.resolve(entity);
    }),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn().mockImplementation((_cls: any, data: any) => data),
  });

  const makeMockQueryRunner = () => {
    const manager = makeMockManager();
    return { manager };
  };

  const makeContext = (
    overrides: Partial<ImportContext> = {},
  ): ImportContext => {
    const qr = makeMockQueryRunner();
    return {
      queryRunner: qr,
      userId,
      accountId,
      account: {
        id: accountId,
        currencyCode: "USD",
        accountSubType: null,
        linkedAccountId: null,
        name: "Investment Account",
      } as any,
      categoryMap: new Map(),
      accountMap: new Map(),
      loanCategoryMap: new Map(),
      securityMap: new Map(),
      importStartTime: new Date(),
      dateCounters: new Map(),
      affectedAccountIds: new Set(),
      importResult: makeImportResult(),
      ...overrides,
    };
  };

  beforeEach(() => {
    service = new ImportInvestmentProcessorService();
  });

  describe("processTransaction", () => {
    it("should map BUY action and create investment transaction", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Apple Inc", "sec-1");
      const ctx = makeContext({ securityMap });

      const qifTx = {
        action: "Buy",
        security: "Apple Inc",
        quantity: 10,
        price: 150,
        commission: 9.99,
        date: "2025-01-15",
        memo: "Buy AAPL",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.queryRunner.manager.save).toHaveBeenCalled();
      expect(ctx.importResult.imported).toBe(1);

      // Verify first save call is the InvestmentTransaction
      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg).toBeInstanceOf(InvestmentTransaction);
      expect(firstSaveArg.action).toBe(InvestmentAction.BUY);
      expect(firstSaveArg.securityId).toBe("sec-1");
      expect(firstSaveArg.quantity).toBe(10);
      expect(firstSaveArg.price).toBe(150);
      expect(firstSaveArg.commission).toBe(9.99);
      // BUY: totalAmount = quantity * price + commission
      expect(firstSaveArg.totalAmount).toBe(1509.99);
    });

    it("should map SELL action and calculate total correctly", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Apple Inc", "sec-1");
      const ctx = makeContext({ securityMap });

      // Set up findOne to return security for cash transaction description
      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "AAPL" });
          }
          // For Holding lookup
          if (entity === Holding) {
            return Promise.resolve({
              accountId,
              securityId: "sec-1",
              quantity: 20,
              averageCost: 140,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Sell",
        security: "Apple Inc",
        quantity: 5,
        price: 160,
        commission: 9.99,
        date: "2025-02-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.SELL);
      // SELL: totalAmount = quantity * price - commission
      expect(firstSaveArg.totalAmount).toBe(790.01);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should map DIV action to DIVIDEND", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Vanguard ETF", "sec-2");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-2") {
            return Promise.resolve({ id: "sec-2", symbol: "VTI" });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Div",
        security: "Vanguard ETF",
        amount: 25.5,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.DIVIDEND);
      expect(firstSaveArg.totalAmount).toBe(25.5);
    });

    it("should map IntInc action to INTEREST", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "IntInc",
        amount: 12.34,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.INTEREST);
    });

    it("should map CGLong and CGShort to CAPITAL_GAIN", async () => {
      const ctx = makeContext();
      const qifTx1 = { action: "CGLong", amount: 100, date: "2025-03-01" };
      await service.processTransaction(ctx, qifTx1);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.CAPITAL_GAIN);
    });

    it("should map StkSplit to SPLIT", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "StkSplit",
        quantity: 100,
        date: "2025-03-01",
      };
      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.SPLIT);
    });

    it("should map ShrsIn to TRANSFER_IN", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "ShrsIn",
        quantity: 50,
        price: 100,
        date: "2025-03-01",
      };
      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.TRANSFER_IN);
    });

    it("should map ShrsOut to TRANSFER_OUT", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "ShrsOut",
        quantity: 25,
        price: 80,
        date: "2025-03-01",
      };
      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.TRANSFER_OUT);
    });

    it("should map ReinvDiv, ReinvInt, ReinvLg, ReinvSh to REINVEST", async () => {
      const actions = ["ReinvDiv", "ReinvInt", "ReinvLg", "ReinvSh"];
      for (const action of actions) {
        const ctx = makeContext();
        const qifTx = {
          action,
          quantity: 5,
          price: 50,
          date: "2025-03-01",
        };
        await service.processTransaction(ctx, qifTx);
        const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
        expect(firstSaveArg.action).toBe(InvestmentAction.REINVEST);
      }
    });

    it("should strip trailing x from action (e.g., BuyX -> Buy)", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      const qifTx = {
        action: "BuyX",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.BUY);
    });

    it("should default to BUY for unknown actions", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "UnknownAction",
        quantity: 10,
        price: 100,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.BUY);
    });

    it("should handle missing action (defaults to BUY)", async () => {
      const ctx = makeContext();
      const qifTx = { quantity: 10, price: 100, date: "2025-03-01" };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.BUY);
    });

    it("should use memo as description when present", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "Buy",
        quantity: 1,
        price: 10,
        date: "2025-03-01",
        memo: "Test memo",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.description).toBe("Test memo");
    });

    it("should fall back to payee as description when memo is absent", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "Buy",
        quantity: 1,
        price: 10,
        date: "2025-03-01",
        payee: "Broker Inc",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.description).toBe("Broker Inc");
    });

    it("should set description to null when both memo and payee are absent", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "Buy",
        quantity: 1,
        price: 10,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.description).toBeNull();
    });

    it("should handle zero quantity and zero price gracefully", async () => {
      const ctx = makeContext();
      const qifTx = { action: "Buy", date: "2025-03-01" };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = ctx.queryRunner.manager.save.mock.calls[0][0];
      expect(firstSaveArg.quantity).toBeNull();
      expect(firstSaveArg.price).toBeNull();
      expect(firstSaveArg.totalAmount).toBe(0);
    });
  });

  describe("autoCreateSecurity (via processTransaction)", () => {
    it("should auto-create a security when not found in securityMap", async () => {
      const ctx = makeContext();

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security) {
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
      );
      ctx.queryRunner.manager.save.mockImplementation((entity: any) => {
        if (!entity.id) entity.id = "new-sec-id";
        return Promise.resolve(entity);
      });

      const qifTx = {
        action: "Buy",
        security: "Apple Computer Inc",
        quantity: 10,
        price: 100,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      // Security should be added to the map
      expect(ctx.securityMap.get("Apple Computer Inc")).toBeDefined();
      expect(ctx.importResult.securitiesCreated).toBeGreaterThanOrEqual(1);
    });

    it("should generate symbol from first letters of words", async () => {
      const ctx = makeContext();

      const savedSecurities: any[] = [];
      ctx.queryRunner.manager.findOne.mockResolvedValue(null);
      ctx.queryRunner.manager.save.mockImplementation((entity: any) => {
        if (!entity.id) entity.id = "new-sec-id";
        savedSecurities.push({ ...entity });
        return Promise.resolve(entity);
      });

      const qifTx = {
        action: "Buy",
        security: "Royal Bank Of Canada",
        quantity: 10,
        price: 100,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      // The generated symbol should be initials + *
      const securitySave = savedSecurities.find(
        (s) => s.symbol && s.symbol.includes("*"),
      );
      expect(securitySave).toBeDefined();
      expect(securitySave.symbol).toBe("RBOC*");
    });

    it("should handle single-word security name (short symbol fallback)", async () => {
      const ctx = makeContext();

      ctx.queryRunner.manager.findOne.mockResolvedValue(null);
      ctx.queryRunner.manager.save.mockImplementation((entity: any) => {
        if (!entity.id) entity.id = "new-sec-id";
        return Promise.resolve(entity);
      });

      const qifTx = {
        action: "Buy",
        security: "X",
        quantity: 10,
        price: 100,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.securityMap.get("X")).toBeDefined();
    });

    it("should reuse existing security with matching symbol and name", async () => {
      const ctx = makeContext();

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.symbol) {
            return Promise.resolve({
              id: "existing-sec-id",
              symbol: opts.where.symbol,
              name: "Test Fund",
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Buy",
        security: "Test Fund",
        quantity: 10,
        price: 50,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.securityMap.get("Test Fund")).toBe("existing-sec-id");
      expect(ctx.importResult.securitiesCreated).toBe(0);
    });

    it("should increment symbol counter when existing security has different name", async () => {
      const ctx = makeContext();

      let callCount = 0;
      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.symbol) {
            callCount++;
            if (callCount === 1) {
              // First lookup: symbol exists with different name
              return Promise.resolve({
                id: "other-sec",
                symbol: opts.where.symbol,
                name: "Different Fund",
              });
            }
            // Second lookup: unique symbol not found
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
      );
      ctx.queryRunner.manager.save.mockImplementation((entity: any) => {
        if (!entity.id) entity.id = "new-sec-id";
        return Promise.resolve(entity);
      });

      const qifTx = {
        action: "Buy",
        security: "Test Fund",
        quantity: 10,
        price: 50,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.securitiesCreated).toBe(1);
    });
  });

  describe("processCashTransaction (via processTransaction)", () => {
    it("should create a cash transaction for BUY with negative amount", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        commission: 10,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      // Should have saved: InvestmentTransaction, cash Transaction, then updated InvestmentTransaction
      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      // The cash transaction should have negative amount for BUY
      const cashTx = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTx).toBeDefined();
      expect(cashTx[0].amount).toBeLessThan(0);
    });

    it("should create cash transaction for SELL with positive amount", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          if (entity === Holding) {
            return Promise.resolve({
              accountId,
              securityId: "sec-1",
              quantity: 100,
              averageCost: 90,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Sell",
        security: "Test Stock",
        quantity: 10,
        price: 120,
        commission: 10,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const cashTx = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTx).toBeDefined();
      expect(cashTx[0].amount).toBeGreaterThan(0);
    });

    it("should NOT create cash transaction for SPLIT action", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "StkSplit",
        quantity: 100,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      // Only the InvestmentTransaction should be saved (no cash transaction)
      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const cashTxCall = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTxCall).toBeUndefined();
    });

    it("should NOT create cash transaction for TRANSFER_IN action", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "ShrsIn",
        quantity: 50,
        price: 100,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const cashTxCall = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTxCall).toBeUndefined();
    });

    it("should use linked account for brokerage accounts", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");

      const ctx = makeContext({
        securityMap,
        account: {
          id: accountId,
          currencyCode: "USD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "linked-acc-1",
          name: "Brokerage",
        } as any,
      });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          if (opts?.where?.id === "linked-acc-1") {
            return Promise.resolve({
              id: "linked-acc-1",
              currencyCode: "CAD",
              currentBalance: 10000,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.affectedAccountIds.has("linked-acc-1")).toBe(true);

      // Cash transaction should go to linked account
      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const cashTx = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "linked-acc-1" &&
          call[0]?.amount !== undefined,
      );
      expect(cashTx).toBeDefined();
    });

    it("should format payee name with Buy label and security details", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        commission: 0,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const cashTx = saveCalls.find(
        (call: any) =>
          call[0]?.payeeName && call[0]?.payeeName.includes("Buy"),
      );
      expect(cashTx).toBeDefined();
      expect(cashTx[0].payeeName).toContain("TST");
      expect(cashTx[0].payeeName).toContain("10");
      expect(cashTx[0].payeeName).toContain("$100.00");
    });
  });

  describe("processHoldings (via processTransaction)", () => {
    it("should create a new holding for BUY when none exists", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          if (entity === Holding) {
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const holdingSave = saveCalls.find(
        (call: any) =>
          call[0] instanceof Holding || call[0]?.averageCost !== undefined,
      );
      expect(holdingSave).toBeDefined();
      expect(holdingSave[0].quantity).toBe(10);
      expect(holdingSave[0].averageCost).toBe(100);
    });

    it("should update existing holding quantity for BUY and recalculate average cost", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          if (entity === Holding) {
            return Promise.resolve({
              accountId,
              securityId: "sec-1",
              quantity: 10,
              averageCost: 80,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 120,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const holdingSave = saveCalls.find(
        (call: any) =>
          call[0]?.securityId === "sec-1" &&
          call[0]?.averageCost !== undefined &&
          call[0]?.quantity === 20,
      );
      expect(holdingSave).toBeDefined();
      // Average: (10*80 + 10*120) / 20 = 2000/20 = 100
      expect(holdingSave[0].averageCost).toBe(100);
      expect(holdingSave[0].quantity).toBe(20);
    });

    it("should decrease holding quantity for SELL", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          if (entity === Holding) {
            return Promise.resolve({
              accountId,
              securityId: "sec-1",
              quantity: 20,
              averageCost: 100,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Sell",
        security: "Test Stock",
        quantity: 5,
        price: 120,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const holdingSave = saveCalls.find(
        (call: any) =>
          call[0]?.securityId === "sec-1" && call[0]?.quantity === 15,
      );
      expect(holdingSave).toBeDefined();
    });

    it("should NOT update holdings for DIVIDEND action", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({ id: "sec-1", symbol: "TST" });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "Div",
        security: "Test Stock",
        amount: 50,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const holdingSave = saveCalls.find(
        (call: any) => call[0]?.averageCost !== undefined,
      );
      // Dividend with no quantity should not create holdings
      expect(holdingSave).toBeUndefined();
    });

    it("should increase holding quantity for REINVEST", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test ETF", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Holding) {
            return Promise.resolve({
              accountId,
              securityId: "sec-1",
              quantity: 50,
              averageCost: 100,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "ReinvDiv",
        security: "Test ETF",
        quantity: 2,
        price: 110,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const holdingSave = saveCalls.find(
        (call: any) => call[0]?.quantity === 52,
      );
      expect(holdingSave).toBeDefined();
    });

    it("should decrease holding quantity for TRANSFER_OUT", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Holding) {
            return Promise.resolve({
              accountId,
              securityId: "sec-1",
              quantity: 100,
              averageCost: 50,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        action: "ShrsOut",
        security: "Test Stock",
        quantity: 30,
        price: 60,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = ctx.queryRunner.manager.save.mock.calls;
      const holdingSave = saveCalls.find(
        (call: any) => call[0]?.quantity === 70,
      );
      expect(holdingSave).toBeDefined();
    });
  });
});
