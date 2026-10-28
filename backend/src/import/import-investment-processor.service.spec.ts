jest.mock("./import-accrual-guard", () => ({
  prepareImportAccrualSources: async () => new Set<string>(),
  assertImportAccrualMatch: async () => undefined,
  assertImportAccrualIds: async () => undefined,
  assertImportAccrualEntry: async () => undefined,
  rememberImportedAccrualSource: () => undefined,
}));
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportContext, bondStateOf } from "./import-context";
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
  let exchangeRateService: Record<string, jest.Mock>;

  const userId = "user-1";
  const accountId = "acc-1";

  const makeImportResult = (): ImportResultDto => ({
    imported: 0,
    skipped: 0,
    skippedRows: [],
    errors: 0,
    errorMessages: [],
    categoriesCreated: 0,
    accountsCreated: 0,
    payeesCreated: 0,
    securitiesCreated: 0,
  });

  const makeMockQueryBuilder = (countResult = 0, oneResult: any = null) => {
    const qb: Record<string, jest.Mock> = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(oneResult),
      getCount: jest.fn().mockResolvedValue(countResult),
    };
    return qb;
  };

  // ctx.manager is typed as a real EntityManager; the spec drives the jest mocks
  // behind it, so read it back through this accessor rather than casting inline.
  const managerOf = (ctx: ImportContext): Record<string, jest.Mock> =>
    ctx.manager as unknown as Record<string, jest.Mock>;

  const makeMockManager = () => ({
    save: jest.fn().mockImplementation((entity: any) => {
      if (!entity.id) {
        entity.id = `gen-${Date.now()}-${Math.random()}`;
      }
      return Promise.resolve(entity);
    }),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    // `updateAccountBalance` moves a balance with one atomic
    // `current_balance = current_balance + $1` statement.
    query: jest.fn().mockResolvedValue([[], 1]),
    create: jest.fn().mockImplementation((_cls: any, data: any) => data),
    createQueryBuilder: jest.fn().mockReturnValue(makeMockQueryBuilder()),
  });

  const makeContext = (
    overrides: Partial<ImportContext> = {},
  ): ImportContext => {
    return {
      manager: makeMockManager() as any,
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
      tagMap: new Map(),
      importStartTime: new Date(),
      dateCounters: new Map(),
      affectedAccountIds: new Set(),
      settledScheduleIds: new Set(),
      importResult: makeImportResult(),
      transferDupCounts: new Map(),
      heldExternalIds: new Map(),
      ...overrides,
    };
  };

  beforeEach(() => {
    // The importer resolves a rate when a security's currency differs from the
    // cash account's rather than posting the security-currency number at par
    // (audit P5-003/P5-009 in the import path). Same-currency trades never reach
    // the lookup, which is every fixture here unless it says otherwise.
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(null),
      getLatestRate: jest.fn().mockResolvedValue(null),
    };
    service = new ImportInvestmentProcessorService(
      exchangeRateService as never,
    );
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

      expect(managerOf(ctx).save).toHaveBeenCalled();
      expect(ctx.importResult.imported).toBe(1);

      // Verify first save call is the InvestmentTransaction
      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg).toBeInstanceOf(InvestmentTransaction);
      expect(firstSaveArg.action).toBe(InvestmentAction.BUY);
      expect(firstSaveArg.securityId).toBe("sec-1");
      expect(firstSaveArg.quantity).toBe(10);
      expect(firstSaveArg.price).toBe(150);
      expect(firstSaveArg.commission).toBe(9.99);
      // BUY: totalAmount = quantity * price + commission
      expect(firstSaveArg.totalAmount).toBe(1509.99);
    });

    describe("the bond series of a program-linked security (INV-BOND-007)", () => {
      const SERIES = "11111111-1111-5111-8111-111111111111";
      const buy = {
        action: "Buy",
        security: "EDO",
        quantity: 10,
        price: 100,
        commission: 0,
        date: "2026-10-15",
      };
      const linked = (
        ctx: ImportContext,
        opts: {
          linked?: boolean;
          onSale: string[];
          /** Successive answers of the ledger read; the last repeats. */
          ledgers?: Array<Array<Record<string, unknown>>>;
        },
      ) => {
        let ledgerReads = 0;
        return managerOf(ctx).query.mockImplementation(async (sql: string) => {
          if (sql.includes("bond_auto_fetch")) {
            return [
              {
                id: "sec-1",
                user_id: "user-1",
                symbol: "EDO",
                currency_code: "PLN",
                bond_program_id: opts.linked === false ? null : "prog-1",
                bond_auto_fetch: false,
              },
            ];
          }
          if (sql.includes("counterpart_account_id")) {
            const all = opts.ledgers ?? [[]];
            const rows = all[Math.min(ledgerReads, all.length - 1)];
            ledgerReads += 1;
            return rows;
          }
          if (sql.includes("s.bond_program_id AS id")) {
            return [
              opts.linked === false
                ? { id: null, program_code: null }
                : { id: "prog-1", program_code: "EDO" },
            ];
          }
          if (sql.includes("saleWindow")) {
            return opts.onSale.map((id) => ({ id }));
          }
          return [[], 1];
        });
      };
      const makeCtx = () =>
        makeContext({ securityMap: new Map([["EDO", "sec-1"]]) });

      it("stores the series the date puts on sale on an imported purchase", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [SERIES] });
        await service.processTransaction(ctx, buy);
        expect(managerOf(ctx).save.mock.calls[0][0].bondInstrumentId).toBe(
          SERIES,
        );
      });

      it("stores NULL, counted, instead of failing the row when no series covers the date (the lots name it)", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [] });
        await service.processTransaction(ctx, buy);
        expect(
          managerOf(ctx).save.mock.calls[0][0].bondInstrumentId,
        ).toBeNull();
        expect(ctx.importResult.imported).toBe(1);
        expect(ctx.importResult.bondRowsWithoutSeries).toBe(1);
      });

      it("omits the count when every acquisition resolved", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [SERIES] });
        await service.processTransaction(ctx, buy);
        expect(ctx.importResult.bondRowsWithoutSeries).toBeUndefined();
      });

      it("never infers the series of a share transfer in (SHRSIN) or a grant from the date", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [SERIES] });
        await service.processTransaction(ctx, { ...buy, action: "ShrsIn" });
        await service.processTransaction(ctx, { ...buy, action: "Grant" });
        const saved = managerOf(ctx)
          .save.mock.calls.map((c) => c[0])
          .filter((e) => e instanceof InvestmentTransaction);
        expect(saved.map((e) => e.bondInstrumentId)).toEqual([null, null]);
        expect(ctx.importResult.bondRowsWithoutSeries).toBe(2);
      });

      it("looks the program up once per run, however many rows the file has", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [SERIES] });
        await service.processTransaction(ctx, buy);
        await service.processTransaction(ctx, { ...buy, date: "2026-10-16" });
        await service.processTransaction(ctx, { ...buy, date: "2026-10-17" });
        const lookups = managerOf(ctx).query.mock.calls.filter(([sql]) =>
          String(sql).includes("s.bond_program_id AS id"),
        );
        expect(lookups).toHaveLength(1);
      });

      it("infers the series on sale once per (program, date), not once per row", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [SERIES] });
        await service.processTransaction(ctx, buy);
        await service.processTransaction(ctx, buy);
        await service.processTransaction(ctx, { ...buy, action: "ReinvDiv" });
        const sameDay = managerOf(ctx).query.mock.calls.filter(([sql]) =>
          String(sql).includes("ORDER BY s.series_code"),
        );
        expect(sameDay).toHaveLength(1);
        const saved = managerOf(ctx)
          .save.mock.calls.map((c) => c[0])
          .filter((e) => e instanceof InvestmentTransaction);
        expect(saved.length).toBeGreaterThanOrEqual(3);
        expect(new Set(saved.map((e) => e.bondInstrumentId))).toEqual(
          new Set([SERIES]),
        );

        await service.processTransaction(ctx, { ...buy, date: "2026-10-16" });
        expect(
          managerOf(ctx).query.mock.calls.filter(([sql]) =>
            String(sql).includes("ORDER BY s.series_code"),
          ),
        ).toHaveLength(2);
      });

      it("remembers a date with no series on sale too (null is an answer)", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [] });
        await service.processTransaction(ctx, buy);
        await service.processTransaction(ctx, buy);
        expect(
          managerOf(ctx).query.mock.calls.filter(([sql]) =>
            String(sql).includes("ORDER BY s.series_code"),
          ),
        ).toHaveLength(1);
        expect(ctx.importResult.bondRowsWithoutSeries).toBe(2);
      });

      it("does not count a row without a series whose cash leg then fails (the caller rolls the row back)", async () => {
        const ctx = makeCtx();
        linked(ctx, { onSale: [] });
        const cash = jest
          .spyOn(service as any, "processCashTransaction")
          .mockRejectedValueOnce(new Error("cash leg failed"));

        await expect(service.processTransaction(ctx, buy)).rejects.toThrow(
          "cash leg failed",
        );
        expect(ctx.importResult.bondRowsWithoutSeries).toBeUndefined();

        cash.mockResolvedValue(undefined as never);
        await service.processTransaction(ctx, buy);
        expect(ctx.importResult.bondRowsWithoutSeries).toBe(1);
      });

      it("the run's guard refuses the file after which a removal is not covered, once it is checked", async () => {
        const ctx = makeCtx();
        const sell = {
          id: "s1",
          action: "SELL",
          status: "CLEARED",
          tx_date: "2026-10-15",
          quantity: "10",
          account_id: "acc-1",
          bond_instrument_id: null,
          counterpart_account_id: null,
        };
        linked(ctx, { onSale: [SERIES], ledgers: [[], [sell]] });
        await service.processTransaction(ctx, { ...buy, action: "Sell" });
        await expect(bondStateOf(ctx).guard.verify()).rejects.toMatchObject({
          response: { errorCode: "OVER_REMOVAL" },
        });
      });

      it("leaves a sale without a series, and an unlinked security's rows without one", async () => {
        const sale = makeCtx();
        linked(sale, { onSale: [SERIES] });
        await service.processTransaction(sale, { ...buy, action: "Sell" });
        expect(
          managerOf(sale).save.mock.calls[0][0].bondInstrumentId,
        ).toBeNull();

        const unlinked = makeCtx();
        linked(unlinked, { linked: false, onSale: [SERIES] });
        await service.processTransaction(unlinked, buy);
        expect(
          managerOf(unlinked).save.mock.calls[0][0].bondInstrumentId,
        ).toBeNull();
      });
    });

    describe("foreign-security cash posting (P5-003 / P5-009 in the import path)", () => {
      // `totalAmount` on an imported row is in the SECURITY's currency. It used
      // to be written straight onto the cash transaction with `exchangeRate: 1`,
      // the row labelled with the security's currency, and the cash account's
      // balance moved by that raw number -- so a 1,000 USD purchase settled from
      // a CAD account took 1,000 CAD out and left a USD-labelled row sitting in a
      // CAD account.
      const usdSecurityInCadAccount = (ctx: ReturnType<typeof makeContext>) => {
        managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
          if (entity === Security && opts?.where?.id === "sec-1") {
            return Promise.resolve({
              id: "sec-1",
              symbol: "AAPL",
              currencyCode: "USD",
            });
          }
          return Promise.resolve(null);
        });
      };

      const buyQif = {
        action: "Buy",
        security: "Apple Inc",
        quantity: 10,
        price: 100,
        commission: 0,
        date: "2025-01-15",
      };

      it("converts the cash effect into the cash account's currency", async () => {
        const securityMap = new Map<string, string | null>([
          ["Apple Inc", "sec-1"],
        ]);
        const ctx = makeContext({
          securityMap,
          account: {
            id: accountId,
            currencyCode: "CAD",
            accountSubType: null,
            linkedAccountId: null,
            name: "Investment Account",
          } as never,
        });
        usdSecurityInCadAccount(ctx);
        exchangeRateService.getRateForDate.mockResolvedValue(1.35);

        await service.processTransaction(ctx, buyQif);

        const cashTx = managerOf(ctx)
          .save.mock.calls.map((c: any[]) => c[0])
          .find((arg: any) => arg?.currencyCode !== undefined);
        expect(cashTx.currencyCode).toBe(ctx.account.currencyCode);
        // 1,000 USD at 1.35 is 1,350 in the account's currency, taken out.
        expect(cashTx.amount).toBe(-1350);
        expect(cashTx.exchangeRate).toBe(1.35);
      });

      it("does not post a cash effect it cannot denominate", async () => {
        // Posting the unconverted number would move a real balance by the wrong
        // amount and look entirely normal. The trade still imports; the user is
        // told which pair is missing.
        const securityMap = new Map<string, string | null>([
          ["Apple Inc", "sec-1"],
        ]);
        const ctx = makeContext({
          securityMap,
          account: {
            id: accountId,
            currencyCode: "CAD",
            accountSubType: null,
            linkedAccountId: null,
            name: "Investment Account",
          } as never,
        });
        usdSecurityInCadAccount(ctx);
        exchangeRateService.getRateForDate.mockResolvedValue(null);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        await service.processTransaction(ctx, buyQif);

        const cashTx = managerOf(ctx)
          .save.mock.calls.map((c: any[]) => c[0])
          .find((arg: any) => arg?.currencyCode !== undefined);
        expect(cashTx).toBeUndefined();
        expect(ctx.importResult.warnings?.join(" ")).toMatch(
          /No exchange rate for USD -> /,
        );
      });
    });

    it("should map SELL action and calculate total correctly", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Apple Inc", "sec-1");
      const ctx = makeContext({ securityMap });

      // Set up findOne to return security for cash transaction description
      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
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
      });

      const qifTx = {
        action: "Sell",
        security: "Apple Inc",
        quantity: 5,
        price: 160,
        commission: 9.99,
        date: "2025-02-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.SELL);
      // SELL: totalAmount = quantity * price - commission
      expect(firstSaveArg.totalAmount).toBe(790.01);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should map DIV action to DIVIDEND", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Vanguard ETF", "sec-2");
      const ctx = makeContext({ securityMap });

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-2") {
          return Promise.resolve({ id: "sec-2", symbol: "VTI" });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "Div",
        security: "Vanguard ETF",
        amount: 25.5,
        date: "2025-03-01",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.INTEREST);
    });

    it("should map CGLong and CGShort to the term'd capital-gain actions", async () => {
      // Short- and long-term gains are taxed differently (issue #1149), so
      // the term survives the import instead of collapsing to CAPITAL_GAIN.
      const cases = [
        { action: "CGLong", expected: InvestmentAction.CAPITAL_GAIN_LONG },
        { action: "CGShort", expected: InvestmentAction.CAPITAL_GAIN_SHORT },
        { action: "CGMid", expected: InvestmentAction.CAPITAL_GAIN },
      ];
      for (const { action, expected } of cases) {
        const ctx = makeContext();
        await service.processTransaction(ctx, {
          action,
          amount: 100,
          date: "2025-03-01",
        });
        const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
        expect(firstSaveArg.action).toBe(expected);
      }
    });

    it("should map StkSplit to SPLIT", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "StkSplit",
        quantity: 100,
        date: "2025-03-01",
      };
      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.TRANSFER_OUT);
    });

    it("should map the reinvestment actions, keeping the income kind", async () => {
      // ReinvDiv stays the base REINVEST; the interest and term'd gain
      // variants carry their kind through (issue #1149).
      const cases = [
        { action: "ReinvDiv", expected: InvestmentAction.REINVEST },
        { action: "ReinvInt", expected: InvestmentAction.REINVEST_INTEREST },
        {
          action: "ReinvLg",
          expected: InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
        },
        {
          action: "ReinvSh",
          expected: InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
        },
        { action: "ReinvMd", expected: InvestmentAction.REINVEST },
      ];
      for (const { action, expected } of cases) {
        const ctx = makeContext();
        const qifTx = {
          action,
          quantity: 5,
          price: 50,
          date: "2025-03-01",
        };
        await service.processTransaction(ctx, qifTx);
        const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
        expect(firstSaveArg.action).toBe(expected);
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.BUY);
    });

    it("should handle missing action (defaults to BUY)", async () => {
      const ctx = makeContext();
      const qifTx = { quantity: 10, price: 100, date: "2025-03-01" };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
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

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.description).toBeNull();
    });

    it("should handle zero quantity and zero price gracefully", async () => {
      const ctx = makeContext();
      const qifTx = { action: "Buy", date: "2025-03-01" };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.quantity).toBeNull();
      expect(firstSaveArg.price).toBeNull();
      expect(firstSaveArg.totalAmount).toBe(0);
    });
  });

  describe("autoCreateSecurity (via processTransaction)", () => {
    it("should auto-create a security when not found in securityMap", async () => {
      const ctx = makeContext();

      managerOf(ctx).findOne.mockImplementation((entity: any, _opts: any) => {
        if (entity === Security) {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      });
      managerOf(ctx).save.mockImplementation((entity: any) => {
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
      managerOf(ctx).findOne.mockResolvedValue(null);
      managerOf(ctx).save.mockImplementation((entity: any) => {
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

      managerOf(ctx).findOne.mockResolvedValue(null);
      managerOf(ctx).save.mockImplementation((entity: any) => {
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

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.symbol) {
          return Promise.resolve({
            id: "existing-sec-id",
            symbol: opts.where.symbol,
            name: "Test Fund",
          });
        }
        return Promise.resolve(null);
      });

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
      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
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
      });
      managerOf(ctx).save.mockImplementation((entity: any) => {
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

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "TST" });
        }
        return Promise.resolve(null);
      });

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
      const saveCalls = managerOf(ctx).save.mock.calls;
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

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
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
      });

      const qifTx = {
        action: "Sell",
        security: "Test Stock",
        quantity: 10,
        price: 120,
        commission: 10,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTx = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTx).toBeDefined();
      expect(cashTx[0].amount).toBeGreaterThan(0);
    });

    it("should create a positive cash transaction for a return of capital", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "TST" });
        }
        return Promise.resolve(null);
      });

      await service.processTransaction(ctx, {
        action: "RtrnCap",
        security: "Test Stock",
        date: "2025-01-15",
        amount: 125.5,
      });

      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTx = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTx[0].totalAmount).toBe(125.5);
      const cashTx = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTx).toBeDefined();
      expect(cashTx[0].amount).toBe(125.5);
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
      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTxCall = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode === "USD" && call[0]?.amount !== undefined,
      );
      expect(cashTxCall).toBeUndefined();
    });

    it("should set totalAmount to 0 for SPLIT regardless of price/quantity fields", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "StkSplit",
        quantity: 2, // ratio
        price: 100, // post-split price
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg.action).toBe(InvestmentAction.SPLIT);
      expect(firstSaveArg.totalAmount).toBe(0);
    });

    it("leaves the stored holding untouched on a SPLIT import", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Apple Inc", "sec-1");
      const ctx = makeContext({ securityMap });

      const existingHolding: any = {
        accountId,
        securityId: "sec-1",
        quantity: 100,
        averageCost: 150,
      };

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "AAPL" });
        }
        if (entity === Holding) {
          return Promise.resolve(existingHolding);
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "StkSplit",
        security: "Apple Inc",
        quantity: 2, // 2-for-1 split
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      // The split is a ledger row; the position it scales is re-derived from
      // the ledger after the block, not multiplied into the stored figure here.
      const savedHolding = managerOf(ctx)
        .save.mock.calls.map((call: any) => call[0])
        .find((arg: any) => arg === existingHolding);
      expect(savedHolding).toBeUndefined();
      expect(existingHolding.quantity).toBe(100);
      expect(existingHolding.averageCost).toBe(150);
    });

    it("does not create a holding from thin air for SPLIT when none exists", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Apple Inc", "sec-1");
      const ctx = makeContext({ securityMap });

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "AAPL" });
        }
        if (entity === Holding) return Promise.resolve(null);
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "StkSplit",
        security: "Apple Inc",
        quantity: 2,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      // No Holding-shaped object should be saved.
      const savedHolding = managerOf(ctx)
        .save.mock.calls.map((call: any) => call[0])
        .find(
          (arg: any) =>
            arg &&
            "averageCost" in arg &&
            "quantity" in arg &&
            "securityId" in arg,
        );
      expect(savedHolding).toBeUndefined();
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

      const saveCalls = managerOf(ctx).save.mock.calls;
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

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
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
      });

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
      const saveCalls = managerOf(ctx).save.mock.calls;
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

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "TST" });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        commission: 0,
        date: "2025-01-15",
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTx = saveCalls.find(
        (call: any) => call[0]?.payeeName && call[0]?.payeeName.includes("Buy"),
      );
      // Exact, not `toContain`: the assertions here were loose enough that
      // swapping the label's hard-coded `$` for the security's real currency
      // broke nothing (issue #1204).
      expect(cashTx).toBeDefined();
      expect(cashTx[0].payeeName).toBe("Buy: TST 10 @ $100.00");
    });

    it("quotes the label in the security's currency, not a hard-coded dollar", async () => {
      // The amount beside it is converted out of that currency two lines
      // later; labelling a EUR-priced trade with `$` contradicts the row.
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });
      exchangeRateService.getRateForDate.mockResolvedValue(1.1);

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({
            id: "sec-1",
            symbol: "TST",
            currencyCode: "EUR",
          });
        }
        return Promise.resolve(null);
      });

      await service.processTransaction(ctx, {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        commission: 0,
        date: "2025-01-15",
      });

      const cashTx = managerOf(ctx).save.mock.calls.find(
        (call: any) => call[0]?.payeeName,
      );
      expect(cashTx[0].payeeName).toBe("Buy: TST 10 @ €100.00");
    });
  });

  describe("holdings are left to the ledger projection", () => {
    it("writes no Holding row for a BUY", async () => {
      // An import arrives in file order, which is not date order, so a per-row
      // average cost blended here disagrees with the ledger replay (issue
      // #1388). `ImportService` rebuilds the imported accounts from the ledger
      // once the block is written, in the same transaction.
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "TST" });
        }
        return Promise.resolve(null);
      });

      await service.processTransaction(ctx, {
        action: "Buy",
        security: "Test Stock",
        quantity: 10,
        price: 100,
        date: "2025-01-15",
      });

      const savedHoldings = managerOf(ctx)
        .save.mock.calls.map((call: any) => call[0])
        .filter((arg: any) => arg instanceof Holding);
      expect(savedHoldings).toEqual([]);
      // ...but the investment row itself is still written.
      expect(ctx.importResult.imported).toBe(1);
    });

    it("writes no Holding row for a SELL", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Stock", "sec-1");
      const ctx = makeContext({ securityMap });

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "TST" });
        }
        return Promise.resolve(null);
      });

      await service.processTransaction(ctx, {
        action: "Sell",
        security: "Test Stock",
        quantity: 4,
        price: 120,
        date: "2025-02-15",
      });

      const savedHoldings = managerOf(ctx)
        .save.mock.calls.map((call: any) => call[0])
        .filter((arg: any) => arg instanceof Holding);
      expect(savedHoldings).toEqual([]);
    });
  });

  describe("Quicken-specific investment action mappings", () => {
    const testActionMapping = async (
      qifAction: string,
      expectedAction: InvestmentAction,
    ) => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("Test Security", "sec-1");
      const ctx = makeContext({ securityMap });

      const qifTx = {
        action: qifAction,
        security: "Test Security",
        quantity: 10,
        price: 100,
        date: "2025-01-15",
        amount: 1000,
      };

      await service.processTransaction(ctx, qifTx);

      const firstSaveArg = managerOf(ctx).save.mock.calls[0][0];
      expect(firstSaveArg).toBeInstanceOf(InvestmentTransaction);
      expect(firstSaveArg.action).toBe(expectedAction);
    };

    it("maps CGMid to CAPITAL_GAIN", async () => {
      await testActionMapping("CGMid", InvestmentAction.CAPITAL_GAIN);
    });

    it("maps CGMidX to CAPITAL_GAIN (X suffix stripped)", async () => {
      await testActionMapping("CGMidX", InvestmentAction.CAPITAL_GAIN);
    });

    it("maps ReinvMd to REINVEST", async () => {
      await testActionMapping("ReinvMd", InvestmentAction.REINVEST);
    });

    it("maps ShtSell to SELL", async () => {
      await testActionMapping("ShtSell", InvestmentAction.SELL);
    });

    it("maps CvrShrt to BUY", async () => {
      await testActionMapping("CvrShrt", InvestmentAction.BUY);
    });

    it("XIn is handled as a cash transfer, not an investment transaction", async () => {
      // XIn bypasses the actionMap and is processed by processCashTransfer,
      // so no InvestmentTransaction record is created.
      const ctx = makeContext();
      const qifTx = {
        action: "XIn",
        date: "2025-01-15",
        amount: 500,
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTxSave = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTxSave).toBeUndefined();
      expect(ctx.importResult.imported).toBe(1);
    });

    it("XOut is handled as a cash transfer, not an investment transaction", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "XOut",
        date: "2025-01-15",
        amount: -200,
      };

      await service.processTransaction(ctx, qifTx);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTxSave = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTxSave).toBeUndefined();
      expect(ctx.importResult.imported).toBe(1);
    });

    it("maps RtrnCap to RETURN_OF_CAPITAL, not DIVIDEND (#1800)", async () => {
      await testActionMapping("RtrnCap", InvestmentAction.RETURN_OF_CAPITAL);
    });

    it("maps MargInt to INTEREST", async () => {
      await testActionMapping("MargInt", InvestmentAction.INTEREST);
    });

    it("maps MiscExp to INTEREST", async () => {
      await testActionMapping("MiscExp", InvestmentAction.INTEREST);
    });

    it("maps MiscInc to INTEREST", async () => {
      await testActionMapping("MiscInc", InvestmentAction.INTEREST);
    });

    it("maps Contrib to BUY", async () => {
      await testActionMapping("Contrib", InvestmentAction.BUY);
    });

    it("maps ContribX to BUY when no transfer account (X suffix stripped)", async () => {
      await testActionMapping("ContribX", InvestmentAction.BUY);
    });

    it("maps Withdrw to SELL", async () => {
      await testActionMapping("Withdrw", InvestmentAction.SELL);
    });

    it("maps WithdrwX to SELL when no transfer account (X suffix stripped)", async () => {
      await testActionMapping("WithdrwX", InvestmentAction.SELL);
    });

    it("maps Exercise to BUY", async () => {
      await testActionMapping("Exercise", InvestmentAction.BUY);
    });

    it("maps Expire to REMOVE_SHARES", async () => {
      await testActionMapping("Expire", InvestmentAction.REMOVE_SHARES);
    });

    it("maps Grant to ADD_SHARES", async () => {
      await testActionMapping("Grant", InvestmentAction.ADD_SHARES);
    });

    it("maps Vest to ADD_SHARES", async () => {
      await testActionMapping("Vest", InvestmentAction.ADD_SHARES);
    });

    it("maps Cash to INTEREST when no transfer account", async () => {
      await testActionMapping("Cash", InvestmentAction.INTEREST);
    });

    it("Cash with transfer account is handled as a cash transfer, not an investment transaction", async () => {
      const ctx = makeContext();
      const qifTx = {
        action: "Cash",
        date: "2025-01-11",
        amount: -3016,
        isTransfer: true,
        transferAccount: "WS Cash - Joint",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      // No InvestmentTransaction should be created
      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTxSave = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTxSave).toBeUndefined();
    });

    it("WithdrwX with transfer account is handled as a cash transfer (like XOut)", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("WS Sandi TFSA", "acc-ws");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-ws") {
          return Promise.resolve({
            id: "acc-ws",
            // Same currency as the importing account: these tests are about
            // transfer mechanics, and the counterpart equals the negated cash
            // amount only when no conversion applies.
            currencyCode: "USD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "WithdrwX",
        date: "2024-02-08",
        amount: 22233.12,
        payee: "Transfer to Wealth Simple",
        isTransfer: true,
        transferAccount: "WS Sandi TFSA",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      // No InvestmentTransaction should be created
      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTxSave = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTxSave).toBeUndefined();

      // Cash transaction should have negative amount (money leaving)
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === accountId && call[0]?.amount === -22233.12,
      );
      expect(cashTxSave).toBeDefined();

      // Linked transaction in the transfer account
      const linkedTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-ws" && call[0]?.amount === 22233.12,
      );
      expect(linkedTxSave).toBeDefined();
      expect(ctx.affectedAccountIds.has("acc-ws")).toBe(true);
    });

    it("ContribX with transfer account is handled as a cash transfer (like XIn)", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("EQ Sandi TFSA", "acc-eq");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-eq") {
          return Promise.resolve({
            id: "acc-eq",
            // Same currency as the importing account: these tests are about
            // transfer mechanics, and the counterpart equals the negated cash
            // amount only when no conversion applies.
            currencyCode: "USD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "ContribX",
        date: "2024-02-08",
        amount: 22233.12,
        payee: "Transfer to Wealth Simple",
        isTransfer: true,
        transferAccount: "EQ Sandi TFSA",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      // No InvestmentTransaction should be created
      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTxSave = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTxSave).toBeUndefined();

      // Cash transaction should have positive amount (money coming in)
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === accountId && call[0]?.amount === 22233.12,
      );
      expect(cashTxSave).toBeDefined();

      // Linked transaction in the transfer account
      const linkedTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-eq" && call[0]?.amount === -22233.12,
      );
      expect(linkedTxSave).toBeDefined();
      expect(ctx.affectedAccountIds.has("acc-eq")).toBe(true);
    });
  });

  describe("XIn / XOut cash transfers", () => {
    it("converts the counterpart into the target account's currency (P5-003)", async () => {
      // USD investment account transferring to a CAD chequing account: the
      // counterpart lives in the target, so it is denominated there. It used
      // to be written as `-cashAmount` -- a USD number -- labelled CAD, equal
      // magnitudes across two currencies with no conversion.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Chequing CAD", "acc-cad");
      const ctx = makeContext({ accountMap });
      exchangeRateService.getRateForDate.mockResolvedValue(1.35);

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-cad") {
          return Promise.resolve({
            id: "acc-cad",
            currencyCode: "CAD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      await service.processTransaction(ctx, {
        action: "XOut",
        date: "2025-01-15",
        amount: 1000,
        payee: "Transfer",
        isTransfer: true,
        transferAccount: "Chequing CAD",
      });

      const saveCalls = managerOf(ctx).save.mock.calls;
      const linkedTxSave = saveCalls.find(
        (call: any) => call[0]?.accountId === "acc-cad",
      );
      expect(linkedTxSave).toBeDefined();
      // -(-1000) * 1.35: converted into CAD, with the rate on the row.
      expect(linkedTxSave[0].amount).toBe(1350);
      expect(linkedTxSave[0].currencyCode).toBe("CAD");
      expect(linkedTxSave[0].exchangeRate).toBe(1.35);
    });

    it("skips the counterpart with a warning when the pair has no rate, instead of mislabelling it", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Chequing THB", "acc-thb");
      const ctx = makeContext({ accountMap });
      exchangeRateService.getRateForDate.mockResolvedValue(null);
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-thb") {
          return Promise.resolve({
            id: "acc-thb",
            currencyCode: "THB",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      await service.processTransaction(ctx, {
        action: "XOut",
        date: "2025-01-15",
        amount: 1000,
        payee: "Transfer",
        isTransfer: true,
        transferAccount: "Chequing THB",
      });

      // The cash leg stands alone; no row in the target and no balance moved
      // there by a number in the wrong currency.
      const saveCalls = managerOf(ctx).save.mock.calls;
      const linkedTxSave = saveCalls.find(
        (call: any) => call[0]?.accountId === "acc-thb",
      );
      expect(linkedTxSave).toBeUndefined();
      expect(
        (ctx.importResult.warnings ?? []).some((w: string) =>
          w.includes("USD -> THB"),
        ),
      ).toBe(true);
    });

    it("XIn creates a cash transaction and a linked transaction in the transfer account", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Chequing", "acc-chequing");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-chequing") {
          return Promise.resolve({
            id: "acc-chequing",
            currencyCode: "USD",
            currentBalance: 5000,
          });
        }
        if (opts?.where?.id === accountId) {
          return Promise.resolve({
            id: accountId,
            currencyCode: "USD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "XIn",
        date: "2025-01-15",
        amount: 1000,
        payee: "Transfer",
        memo: "Cash in",
        isTransfer: true,
        transferAccount: "Chequing",
        cleared: true,
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      expect(ctx.importResult.skipped).toBe(0);

      // No InvestmentTransaction should be created
      const saveCalls = managerOf(ctx).save.mock.calls;
      const investmentTxSave = saveCalls.find(
        (call: any) => call[0] instanceof InvestmentTransaction,
      );
      expect(investmentTxSave).toBeUndefined();

      // Cash transaction saved in the investment account
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === accountId && call[0]?.amount === 1000,
      );
      expect(cashTxSave).toBeDefined();

      // Linked transaction saved in the transfer account
      const linkedTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-chequing" && call[0]?.amount === -1000,
      );
      expect(linkedTxSave).toBeDefined();
      expect(ctx.affectedAccountIds.has("acc-chequing")).toBe(true);
    });

    it("XOut creates a cash transaction and a linked transaction in the transfer account", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-savings") {
          return Promise.resolve({
            id: "acc-savings",
            currencyCode: "USD",
            currentBalance: 2000,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "XOut",
        date: "2025-01-20",
        amount: -500,
        payee: "Withdrawal",
        isTransfer: true,
        transferAccount: "Savings",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === accountId && call[0]?.amount === -500,
      );
      expect(cashTxSave).toBeDefined();

      const linkedTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-savings" && call[0]?.amount === 500,
      );
      expect(linkedTxSave).toBeDefined();
    });

    it("XOut with positive amount negates it (Quicken convention)", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("WS Joint LT", "acc-ws-joint");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-ws-joint") {
          return Promise.resolve({
            id: "acc-ws-joint",
            // Same currency as the importing account: these tests are about
            // transfer mechanics, and the counterpart equals the negated cash
            // amount only when no conversion applies.
            currencyCode: "USD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "XOut",
        date: "2025-06-14",
        amount: 76180,
        payee: "End of Term",
        isTransfer: true,
        transferAccount: "WS Joint LT",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      const saveCalls = managerOf(ctx).save.mock.calls;
      // Cash transaction should be NEGATIVE (money leaving)
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === accountId && call[0]?.amount === -76180,
      );
      expect(cashTxSave).toBeDefined();

      // Linked transaction should be POSITIVE (money arriving)
      const linkedTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-ws-joint" && call[0]?.amount === 76180,
      );
      expect(linkedTxSave).toBeDefined();
    });

    it("XOut then XIn for same transfer skips the XIn as duplicate", async () => {
      // Simulates a full QIF import where both sides of a transfer between
      // two investment accounts are present.  The XOut is processed first and
      // creates the transfer pair.  When the XIn is processed, the duplicate
      // detection should find the already-created linked transfer and skip it.
      const accountMap = new Map<string, string | null>();
      accountMap.set("WS Joint LT", "acc-ws-joint");
      accountMap.set("EQ Bank GIC", "acc-eq-gic");

      // --- Process XOut on EQ Bank GIC side ---
      const ctxEq = makeContext({
        accountMap,
        account: {
          id: "acc-eq-gic-brokerage",
          currencyCode: "CAD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "acc-eq-gic",
          name: "EQ Bank GIC - Brokerage",
        } as any,
      });
      // Override accountId to brokerage
      (ctxEq as any).accountId = "acc-eq-gic-brokerage";

      managerOf(ctxEq).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-eq-gic") {
          return Promise.resolve({
            id: "acc-eq-gic",
            currencyCode: "CAD",
            currentBalance: 80000,
          });
        }
        if (opts?.where?.id === "acc-ws-joint") {
          return Promise.resolve({
            id: "acc-ws-joint",
            // Same currency as this test's CAD importing account, for the same
            // reason the sibling fixtures match theirs: the duplicate-counting
            // assertions compare unconverted amounts.
            currencyCode: "CAD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const xOutTx = {
        action: "XOut",
        date: "2025-06-14",
        amount: 76180,
        payee: "End of Term",
        isTransfer: true,
        transferAccount: "WS Joint LT",
      };

      await service.processTransaction(ctxEq, xOutTx);
      expect(ctxEq.importResult.imported).toBe(1);

      // Verify: negative in source, positive in target
      const eqSaves = managerOf(ctxEq).save.mock.calls;
      const sourceTx = eqSaves.find(
        (call: any) =>
          call[0]?.accountId === "acc-eq-gic" && call[0]?.amount === -76180,
      );
      expect(sourceTx).toBeDefined();
      const targetTx = eqSaves.find(
        (call: any) =>
          call[0]?.accountId === "acc-ws-joint" && call[0]?.amount === 76180,
      );
      expect(targetTx).toBeDefined();

      // --- Process XIn on WS Joint LT side ---
      const ctxWs = makeContext({
        accountMap,
        account: {
          id: "acc-ws-joint-brokerage",
          currencyCode: "CAD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "acc-ws-joint",
          name: "WS Joint LT - Brokerage",
        } as any,
      });
      (ctxWs as any).accountId = "acc-ws-joint-brokerage";

      // Duplicate detection: the XOut already created a linked transfer in
      // acc-ws-joint (amount=76180) linked to acc-eq-gic, so count=1
      managerOf(ctxWs).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(1),
      );

      const xInTx = {
        action: "XIn",
        date: "2025-06-14",
        amount: 76180,
        payee: "End of Term",
        isTransfer: true,
        transferAccount: "EQ Bank GIC",
      };

      await service.processTransaction(ctxWs, xInTx);

      // XIn should be skipped because XOut already created the transfer pair
      expect(ctxWs.importResult.skipped).toBe(1);
      expect(ctxWs.importResult.imported).toBe(0);
    });

    it("XIn with no transfer account creates only a cash transaction", async () => {
      const ctx = makeContext();

      const qifTx = {
        action: "XIn",
        date: "2025-02-01",
        amount: 200,
        isTransfer: false,
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      const saveCalls = managerOf(ctx).save.mock.calls;
      // Only the cash TX and the balance update (via findOne/update) -- no linked TX
      const txSaves = saveCalls.filter(
        (call: any) => call[0]?.accountId === accountId,
      );
      expect(txSaves.length).toBe(1);
    });

    it("XIn for brokerage account routes cash to the linked cash account", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Chequing", "acc-chequing");
      const ctx = makeContext({
        accountMap,
        account: {
          id: accountId,
          currencyCode: "USD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "acc-cash",
          name: "My Brokerage",
        } as any,
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-cash") {
          return Promise.resolve({
            id: "acc-cash",
            currencyCode: "USD",
            currentBalance: 0,
          });
        }
        if (opts?.where?.id === "acc-chequing") {
          return Promise.resolve({
            id: "acc-chequing",
            currencyCode: "USD",
            currentBalance: 5000,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "XIn",
        date: "2025-03-01",
        amount: 750,
        isTransfer: true,
        transferAccount: "Chequing",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      expect(ctx.affectedAccountIds.has("acc-cash")).toBe(true);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-cash" && call[0]?.amount === 750,
      );
      expect(cashTxSave).toBeDefined();
    });

    it("duplicate XIn is skipped using counting when already exists in DB", async () => {
      // If a matching linked transfer already exists (e.g. from a prior import
      // of the counterpart account), the XIn should be skipped.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Chequing", "acc-chequing");
      const ctx = makeContext({ accountMap });

      // Duplicate detection query returns count=1 (already imported once)
      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(1),
      );

      const qifTx = {
        action: "XIn",
        date: "2025-01-15",
        amount: 300,
        isTransfer: true,
        transferAccount: "Chequing",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
      expect(ctx.importResult.imported).toBe(0);
      expect(ctx.importResult.skippedRows).toEqual([
        {
          date: "2025-01-15",
          amount: 300,
          currencyCode: "USD",
          payee: "",
          reason: "duplicateTransfer",
        },
      ]);
    });

    it("Cash with transfer account creates linked transactions like XOut", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("WS Cash - Joint", "acc-cash-joint");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-cash-joint") {
          return Promise.resolve({
            id: "acc-cash-joint",
            // Same currency as the importing account: these tests are about
            // transfer mechanics, and the counterpart equals the negated cash
            // amount only when no conversion applies.
            currencyCode: "USD",
            currentBalance: 10000,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "Cash",
        date: "2025-01-11",
        amount: -3016,
        payee: "Transfer To WS Cash - Joint",
        isTransfer: true,
        transferAccount: "WS Cash - Joint",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      const saveCalls = managerOf(ctx).save.mock.calls;

      // Cash transaction on the investment side
      const cashTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === accountId && call[0]?.amount === -3016,
      );
      expect(cashTxSave).toBeDefined();

      // Linked transaction on the transfer account side
      const linkedTxSave = saveCalls.find(
        (call: any) =>
          call[0]?.accountId === "acc-cash-joint" && call[0]?.amount === 3016,
      );
      expect(linkedTxSave).toBeDefined();
    });

    it("XIn self-referencing transfer on brokerage creates single deposit, not net-zero pair", async () => {
      // When the transfer account resolves to the same cash account as the
      // brokerage's linked account, no linked transaction should be created.
      // This prevents a +/- pair that nets to zero.
      const accountMap = new Map<string, string | null>();
      accountMap.set("SL Sandi RRSP (Baymag)", "acc-cash");
      const ctx = makeContext({
        accountMap,
        account: {
          id: "acc-brokerage",
          currencyCode: "CAD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "acc-cash",
          name: "SL Sandi RRSP (Baymag) - Brokerage",
        } as any,
      });
      (ctx as any).accountId = "acc-brokerage";

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-cash") {
          return Promise.resolve({
            id: "acc-cash",
            currencyCode: "CAD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "XIn",
        date: "2026-02-28",
        amount: 571.24,
        payee: "Monthly Update",
        isTransfer: true,
        transferAccount: "SL Sandi RRSP (Baymag)",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      const saveCalls = managerOf(ctx).save.mock.calls;
      // Only one cash transaction (the deposit), no linked counterpart
      const cashTxSaves = saveCalls.filter(
        (call: any) => call[0]?.amount !== undefined,
      );
      expect(cashTxSaves.length).toBe(1);
      expect(cashTxSaves[0][0].accountId).toBe("acc-cash");
      expect(cashTxSaves[0][0].amount).toBe(571.24);
      expect(cashTxSaves[0][0].isTransfer).toBe(false);
    });

    it("XOut self-referencing transfer on brokerage creates single withdrawal", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("My RRSP", "acc-cash");
      const ctx = makeContext({
        accountMap,
        account: {
          id: "acc-brokerage",
          currencyCode: "CAD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "acc-cash",
          name: "My RRSP - Brokerage",
        } as any,
      });
      (ctx as any).accountId = "acc-brokerage";

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-cash") {
          return Promise.resolve({
            id: "acc-cash",
            currencyCode: "CAD",
            currentBalance: 1000,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        action: "XOut",
        date: "2026-03-15",
        amount: 200,
        payee: "Withdrawal",
        isTransfer: true,
        transferAccount: "My RRSP",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);

      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTxSaves = saveCalls.filter(
        (call: any) => call[0]?.amount !== undefined,
      );
      expect(cashTxSaves.length).toBe(1);
      expect(cashTxSaves[0][0].accountId).toBe("acc-cash");
      expect(cashTxSaves[0][0].amount).toBe(-200);
      expect(cashTxSaves[0][0].isTransfer).toBe(false);
    });

    it("two XIn transfers with same signature are not both skipped (counting logic)", async () => {
      // Two genuine XIn transfers on the same day for the same amount from the
      // same account should both be imported even when the second one finds
      // existingCount=1 in the DB (the record created by the first XIn).
      // The "always count" logic ensures seenSoFar=1 by the time the second
      // XIn runs, so seenSoFar+1=2 > existingCount=1 → not skipped.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Chequing", "acc-chequing");
      const ctx = makeContext({ accountMap });

      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(0);
        // 1st XIn: existingCount=0 (DB empty). Counter bumped to 1.
        // 2nd XIn: existingCount=1 (1st XIn created a linked TX). Counter
        //   is already 1, so seenSoFar+1=2 > 1 → not skipped.
        if (qbCallCount === 2) {
          qb.getCount.mockResolvedValue(1);
        }
        return qb;
      });

      managerOf(ctx).findOne.mockResolvedValue({
        id: "acc-chequing",
        currencyCode: "USD",
        currentBalance: 0,
      });

      const qifTx = {
        action: "XIn",
        date: "2025-01-15",
        amount: 300,
        isTransfer: true,
        transferAccount: "Chequing",
      };

      await service.processTransaction(ctx, { ...qifTx });
      await service.processTransaction(ctx, { ...qifTx });

      expect(ctx.importResult.imported).toBe(2);
      expect(ctx.importResult.skipped).toBe(0);
    });
  });

  describe("CSV-emitted action codes", () => {
    it("maps addshares to ADD_SHARES with no cost and no cash leg", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("AAPL", "sec-1");
      const ctx = makeContext({ securityMap });

      await service.processTransaction(ctx, {
        action: "addshares",
        security: "AAPL",
        quantity: 25,
        price: 0,
        commission: 0,
        amount: 0,
        date: "2026-01-15",
      });

      const saved = managerOf(ctx).save.mock.calls[0][0];
      expect(saved).toBeInstanceOf(InvestmentTransaction);
      expect(saved.action).toBe(InvestmentAction.ADD_SHARES);
      expect(saved.quantity).toBe(25);
      // An unknown cost is persisted as NULL, never as a zero price
      expect(saved.price).toBeNull();
      expect(saved.totalAmount).toBe(0);
      // No cash transaction leg: ADD_SHARES has no cash impact. Asserted by the
      // absence of a saved cash Transaction (currencyCode + amount), mirroring
      // the StkSplit sibling above -- not by a raw save count, because the
      // holding IS now updated: folding ADD_SHARES through the shared reducer
      // (this concept) is exactly what upstream's processHoldings dropped, so a
      // Holding save legitimately joins the investment row.
      const saveCalls = managerOf(ctx).save.mock.calls;
      const cashTxCall = saveCalls.find(
        (call: any) =>
          call[0]?.currencyCode !== undefined && call[0]?.amount !== undefined,
      );
      expect(cashTxCall).toBeUndefined();
      expect(ctx.importResult.imported).toBe(1);
    });

    it("maps removeshares to REMOVE_SHARES", async () => {
      const securityMap = new Map<string, string | null>();
      securityMap.set("AAPL", "sec-1");
      const holding = { quantity: 100, averageCost: 50 } as unknown as Holding;
      const ctx = makeContext({ securityMap });
      managerOf(ctx).findOne.mockImplementation((cls: any) =>
        Promise.resolve(cls === Holding ? holding : null),
      );

      await service.processTransaction(ctx, {
        action: "removeshares",
        security: "AAPL",
        quantity: 10,
        price: 0,
        commission: 0,
        amount: 0,
        date: "2026-01-16",
      });

      const saved = managerOf(ctx).save.mock.calls[0][0];
      expect(saved.action).toBe(InvestmentAction.REMOVE_SHARES);
      expect(saved.totalAmount).toBe(0);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("books xin with no transfer account as a plain cash deposit on the linked cash account", async () => {
      const ctx = makeContext({
        account: {
          id: accountId,
          currencyCode: "USD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "cash-1",
          name: "Brokerage",
        } as any,
      });

      await service.processTransaction(ctx, {
        action: "xin",
        security: "",
        quantity: 0,
        price: 0,
        commission: 0,
        amount: 500,
        date: "2026-02-05",
        payee: "Contribution",
      });

      // A single cash Transaction is created; no InvestmentTransaction row
      expect(managerOf(ctx).save).toHaveBeenCalledTimes(1);
      const created = managerOf(ctx).create.mock.calls[0][1];
      expect(created.accountId).toBe("cash-1");
      expect(created.amount).toBe(500);
      expect(created.isTransfer).toBe(false);
      expect(managerOf(ctx).save.mock.calls[0][0]).not.toBeInstanceOf(
        InvestmentTransaction,
      );
      expect(ctx.affectedAccountIds.has("cash-1")).toBe(true);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("books xout with a positive file amount as a negative cash movement", async () => {
      const ctx = makeContext({
        account: {
          id: accountId,
          currencyCode: "USD",
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
          linkedAccountId: "cash-1",
          name: "Brokerage",
        } as any,
      });

      await service.processTransaction(ctx, {
        action: "xout",
        security: "",
        quantity: 0,
        price: 0,
        commission: 0,
        amount: 25,
        date: "2026-02-06",
        payee: "Management Fee",
      });

      const created = managerOf(ctx).create.mock.calls[0][1];
      expect(created.accountId).toBe("cash-1");
      expect(created.amount).toBe(-25);
      expect(ctx.importResult.imported).toBe(1);
    });
  });

  describe("parsed status lands on the investment row and its cash leg", () => {
    const withSecurity = (ctx: ImportContext) => {
      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Security && opts?.where?.id === "sec-1") {
          return Promise.resolve({ id: "sec-1", symbol: "TST" });
        }
        return Promise.resolve(null);
      });
    };

    const buyWith = (flags: Record<string, unknown>) => ({
      action: "Buy",
      security: "Test Stock",
      quantity: 10,
      price: 100,
      commission: 0,
      date: "2025-01-15",
      ...flags,
    });

    const makeBuyContext = () => {
      const securityMap = new Map<string, string | null>([
        ["Test Stock", "sec-1"],
      ]);
      const ctx = makeContext({ securityMap });
      withSecurity(ctx);
      return ctx;
    };

    const cashTxOf = (ctx: ImportContext) =>
      managerOf(ctx)
        .save.mock.calls.map((call: any[]) => call[0])
        .find(
          (arg: any) =>
            arg?.currencyCode !== undefined && arg?.amount !== undefined,
        );

    const holdingSaveOf = (ctx: ImportContext) =>
      managerOf(ctx)
        .save.mock.calls.map((call: any[]) => call[0])
        .find(
          (arg: any) =>
            arg instanceof Holding || arg?.averageCost !== undefined,
        );

    it("a reconciled Buy imports RECONCILED on both the row and its cash leg", async () => {
      const ctx = makeBuyContext();

      await service.processTransaction(ctx, buyWith({ reconciled: true }));

      const investmentTx = managerOf(ctx).save.mock.calls[0][0];
      expect(investmentTx).toBeInstanceOf(InvestmentTransaction);
      expect(investmentTx.status).toBe(TransactionStatus.RECONCILED);
      expect(cashTxOf(ctx)?.status).toBe(TransactionStatus.RECONCILED);
    });

    it("a Buy with no flags imports UNRECONCILED on both sides", async () => {
      // Adversarial against the old implementation, which hard-coded CLEARED
      // on the cash leg and carried nothing on the investment row: this case
      // fails there with status CLEARED.
      const ctx = makeBuyContext();

      await service.processTransaction(ctx, buyWith({}));

      const investmentTx = managerOf(ctx).save.mock.calls[0][0];
      expect(investmentTx.status).toBe(TransactionStatus.UNRECONCILED);
      expect(cashTxOf(ctx)?.status).toBe(TransactionStatus.UNRECONCILED);
    });

    it("a voided Buy imports a VOID row and touches no holdings", async () => {
      // Fails against the naive implementation that updates holdings
      // unconditionally: a voided trade's shares must not enter the position.
      const ctx = makeBuyContext();

      await service.processTransaction(ctx, buyWith({ void: true }));

      const investmentTx = managerOf(ctx).save.mock.calls[0][0];
      expect(investmentTx.status).toBe(TransactionStatus.VOID);
      // The cash leg is still recorded, VOID, so the event stays visible.
      expect(cashTxOf(ctx)?.status).toBe(TransactionStatus.VOID);
      expect(holdingSaveOf(ctx)).toBeUndefined();
    });

    it("a voided XIn cash transfer imports a VOID cash transaction", async () => {
      // processCashTransfer used to ignore the void flag entirely, so a
      // cancelled transfer landed live.
      const ctx = makeContext();

      await service.processTransaction(ctx, {
        action: "XIn",
        date: "2025-01-15",
        amount: 500,
        payee: "Transfer",
        void: true,
      });

      const created = managerOf(ctx).create.mock.calls[0][1];
      expect(created.amount).toBe(500);
      expect(created.status).toBe(TransactionStatus.VOID);
    });
  });
});
