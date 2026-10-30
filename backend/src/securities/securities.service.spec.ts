import { SeriesFetchError } from "../bonds/bond-adapter";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { SecuritiesService } from "./securities.service";
import { Security } from "./entities/security.entity";
import { SecurityTag } from "./entities/security-tag.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withUserContext } from "../common/db/with-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * The row `update()` locks (`SELECT ... FOR UPDATE`) mirrors the security the
 * test had `findOne` return, as the database would return the same row.
 */
let lockedRowOf: () => Promise<unknown[]> = async () => [];
const queryWith =
  (other: (sql: string, params: unknown[]) => unknown) =>
  async (sql: string, params: unknown[]) =>
    /FOR UPDATE/.test(sql) ? lockedRowOf() : other(sql, params);

describe("SecuritiesService", () => {
  let service: SecuritiesService;
  let securitiesRepository: Record<string, any>;
  let securityTagsRepository: Record<string, jest.Mock>;
  let holdingsRepository: Record<string, jest.Mock>;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let userPreferencesRepository: Record<string, jest.Mock>;
  let mockSecurityPriceService: Record<string, jest.Mock>;
  let mockActionHistoryService: Record<string, jest.Mock>;
  let mockYahooFinanceService: Record<string, jest.Mock>;
  let mockBondPriceService: Record<string, jest.Mock>;
  let mockBondSeriesService: { fetchProgramOffer: jest.Mock };
  let queryRunnerManager: Record<string, jest.Mock>;
  let scopedRepository: Record<string, any>;
  let scopedManager: Record<string, jest.Mock>;
  let mockDataSource: Record<string, any>;

  const mockSecurity = {
    id: "sec-1",
    userId: "user-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    securitiesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-sec" })),
      save: jest.fn().mockImplementation((data) => data),
      // `findAll` decorates results with lastPriceSource via manager.query.
      manager: { query: jest.fn().mockResolvedValue([]) },
      update: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
        getRawMany: jest.fn().mockResolvedValue([]),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    holdingsRepository = {
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    investmentTransactionsRepository = {
      createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
      })),
    };

    userPreferencesRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    mockSecurityPriceService = {
      backfillSecurity: jest.fn().mockResolvedValue(undefined),
      lookupSecurityCandidates: jest.fn().mockResolvedValue([]),
      // Default: provider reports no currency, so previewCreateSecurity keeps
      // the lookup's exchange-derived currency. Tests that exercise the
      // authoritative-currency override set their own resolved value.
      fetchAuthoritativeCurrency: jest.fn().mockResolvedValue(null),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    mockBondPriceService = {
      recomputeSecurity: jest
        .fn()
        .mockResolvedValue({ written: 0, deleted: 0 }),
      clearEnginePrices: jest
        .fn()
        .mockResolvedValue({ deleted: 0, accountIds: [] }),
      publishClearedPrices: jest.fn(),
    };

    mockBondSeriesService = {
      fetchProgramOffer: jest.fn().mockResolvedValue({
        listed: 1,
        stored: 1,
        alreadyStored: 0,
        failed: 0,
      }),
    };

    mockYahooFinanceService = {
      fetchSecurityProfileDescription: jest.fn(),
      fetchSecurityProfile: jest.fn().mockResolvedValue(null),
    };

    securityTagsRepository = {
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    // QueryRunner manager used by create()/update(). create() does
    // `create(Security, data)` + `save(entity)`; update() does
    // `save(Security, scalars)`; setSecurityTags does find/delete/save/create.
    queryRunnerManager = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation((_entity, data) => ({ ...data, id: "new-sec" })),
      save: jest.fn().mockImplementation((a, b) => b ?? a),
      delete: jest.fn().mockResolvedValue(undefined),
      find: jest.fn().mockResolvedValue([]),
    };

    // deleteAssetOption and the other query-builder reads go through the same
    // Security repository mock now that every path shares one EntityManager.
    scopedRepository = securitiesRepository;

    const { manager, dataSource } = createScopedDbMocks([
      [Security, securitiesRepository],
      [SecurityTag, securityTagsRepository],
      [Holding, holdingsRepository],
      [InvestmentTransaction, investmentTransactionsRepository],
      [UserPreference, userPreferencesRepository],
    ]);
    scopedManager = manager;
    // The direct EntityManager calls create()/update()/setSecurityTags make.
    for (const [name, impl] of Object.entries(queryRunnerManager)) {
      manager[name].mockImplementation(impl.getMockImplementation()!);
    }
    lockedRowOf = async () => {
      const first = securitiesRepository.findOne.mock.results[0];
      const security = first ? await first.value : null;
      return security
        ? [
            {
              bond_program_id: security.bondProgramId ?? null,
              security_type: security.securityType ?? null,
              currency_code: security.currencyCode,
            },
          ]
        : [];
    };
    queryRunnerManager = manager;
    manager.query.mockImplementation(queryWith(() => []));
    mockDataSource = dataSource;

    service = new SecuritiesService(
      mockSecurityPriceService as never,
      mockYahooFinanceService as never,
      mockActionHistoryService as never,
      dataSource as never,
      mockBondPriceService as never,
      mockBondSeriesService as never,
    );
  });

  describe("previewCreateSecurity", () => {
    const lookupResult = {
      symbol: "AAPL",
      name: "Apple Inc.",
      exchange: "NASDAQ",
      securityType: "STOCK",
      currencyCode: "USD",
      provider: "yahoo" as const,
      msnInstrumentId: null,
    };

    it("resolves a security via the provider lookup and fills every field", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        lookupResult,
      ]);
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AAPL",
      });

      expect(
        mockSecurityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "AAPL", undefined);
      expect(preview).toEqual({
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK",
        exchange: "NASDAQ",
        currencyCode: "USD",
        isFavourite: false,
        quoteProvider: "yahoo",
        msnInstrumentId: null,
      });
    });

    it("prefers the live-quote currency over the exchange-guessed one (USD ETF on LSE)", async () => {
      // Lookup guesses GBP from the LSE exchange, but the instrument trades in
      // USD -- the live quote is authoritative.
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        {
          symbol: "AGGG.L",
          name: "iShares Core Global Aggregate Bond UCITS ETF USD (Dist)",
          exchange: "LSE",
          securityType: "ETF",
          currencyCode: "GBP",
          provider: "yahoo" as const,
          msnInstrumentId: null,
        },
      ]);
      mockSecurityPriceService.fetchAuthoritativeCurrency.mockResolvedValue(
        "USD",
      );
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AGGG.L",
        exchange: "LSE",
      });

      expect(preview.currencyCode).toBe("USD");
      expect(
        mockSecurityPriceService.fetchAuthoritativeCurrency,
      ).toHaveBeenCalledWith("user-1", "AGGG.L", "LSE");
    });

    it("keeps the lookup currency when no live-quote currency is available", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        lookupResult,
      ]);
      mockSecurityPriceService.fetchAuthoritativeCurrency.mockResolvedValue(
        null,
      );
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AAPL",
      });

      expect(preview.currencyCode).toBe("USD");
    });

    it("lets the caller override exchange/type and pin as favourite", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        lookupResult,
      ]);
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AAPL",
        exchange: "NYSE",
        securityType: "ETF",
        isFavourite: true,
      });

      expect(
        mockSecurityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "AAPL", ["NYSE"]);
      expect(preview.exchange).toBe("NYSE");
      expect(preview.securityType).toBe("ETF");
      expect(preview.isFavourite).toBe(true);
    });

    it("throws when the query is blank", async () => {
      await expect(
        service.previewCreateSecurity("user-1", { query: "  " }),
      ).rejects.toThrow(BadRequestException);
      expect(
        mockSecurityPriceService.lookupSecurityCandidates,
      ).not.toHaveBeenCalled();
    });

    it("throws when no security is found", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([]);

      await expect(
        service.previewCreateSecurity("user-1", { query: "ZZZZ" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws an ambiguity error when several tickers match and no exchange is given", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        { ...lookupResult, symbol: "SHOP", exchange: "TSX" },
        { ...lookupResult, symbol: "SHOP", name: "Shopify", exchange: "NYSE" },
        { ...lookupResult, symbol: "SHOPX", name: "Other", exchange: "NASDAQ" },
      ]);

      await expect(
        service.previewCreateSecurity("user-1", { query: "shopify" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when the duplicate symbol already exists", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        lookupResult,
      ]);
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);

      await expect(
        service.previewCreateSecurity("user-1", { query: "AAPL" }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws when the provider cannot supply a currency", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        { ...lookupResult, currencyCode: null },
      ]);
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.previewCreateSecurity("user-1", { query: "AAPL" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("uses an explicit currency override over the looked-up currency", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        { ...lookupResult, currencyCode: "USD" },
      ]);
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AAPL",
        currencyCode: "cad",
      });

      expect(preview.currencyCode).toBe("CAD");
    });

    it("lets an explicit currency rescue a lookup with no currency", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        { ...lookupResult, currencyCode: null },
      ]);
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AAPL",
        currencyCode: "EUR",
      });

      expect(preview.currencyCode).toBe("EUR");
    });

    it("prefers the authoritative live-quote currency over an explicit override", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        { ...lookupResult, currencyCode: "GBP" },
      ]);
      mockSecurityPriceService.fetchAuthoritativeCurrency.mockResolvedValue(
        "USD",
      );
      securitiesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreateSecurity("user-1", {
        query: "AGGG.L",
        currencyCode: "EUR",
      });

      expect(preview.currencyCode).toBe("USD");
    });
  });

  describe("lookupSecuritiesForLlm", () => {
    it("returns every candidate and flags ones already in the library", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([
        {
          symbol: "AAPL",
          name: "Apple Inc.",
          exchange: "NASDAQ",
          securityType: "STOCK",
          currencyCode: "USD",
          provider: "yahoo",
          msnInstrumentId: null,
        },
        {
          symbol: "APC.F",
          name: "Apple Inc.",
          exchange: "FRA",
          securityType: "STOCK",
          currencyCode: "EUR",
          provider: "yahoo",
          msnInstrumentId: null,
        },
      ]);
      // The user already owns AAPL.
      securitiesRepository.find.mockResolvedValue([{ symbol: "aapl" }]);

      const result = await service.lookupSecuritiesForLlm("user-1", {
        query: "apple",
      });

      expect(
        mockSecurityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "apple", undefined, undefined);
      expect(result.count).toBe(2);
      expect(result.candidates[0]).toMatchObject({
        symbol: "AAPL",
        alreadyAdded: true,
      });
      expect(result.candidates[1].alreadyAdded).toBe(false);
    });

    it("passes an exchange filter through to the provider lookup", async () => {
      mockSecurityPriceService.lookupSecurityCandidates.mockResolvedValue([]);
      securitiesRepository.find.mockResolvedValue([]);

      await service.lookupSecuritiesForLlm("user-1", {
        query: "apple",
        exchange: "NASDAQ",
        provider: "msn",
      });

      expect(
        mockSecurityPriceService.lookupSecurityCandidates,
      ).toHaveBeenCalledWith("user-1", "apple", ["NASDAQ"], "msn");
    });

    it("rejects an empty query", async () => {
      await expect(
        service.lookupSecuritiesForLlm("user-1", { query: "  " }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("create", () => {
    describe("bond link (spec 12.1)", () => {
      const PROGRAM = "11111111-1111-5111-8111-111111111111";
      const bond = {
        symbol: "TOS1029",
        name: "TOS 3y",
        securityType: "BOND",
        currencyCode: "PLN",
        bondProgramId: PROGRAM,
      };

      it("checks the instrument in the write's transaction, before the save, then recomputes after it", async () => {
        queryRunnerManager.findOne.mockResolvedValue(null);
        queryRunnerManager.query.mockResolvedValue([{ currency_code: "PLN" }]);
        const order: string[] = [];
        queryRunnerManager.query.mockImplementation(async () => {
          order.push("check");
          return [{ currency_code: "PLN" }];
        });
        queryRunnerManager.save.mockImplementation(async (a, b) => {
          order.push("save");
          return b ?? a;
        });
        mockBondPriceService.recomputeSecurity.mockImplementation(async () => {
          order.push("recompute");
          return { written: 0, deleted: 0 };
        });

        await service.create("user-1", bond);

        expect(queryRunnerManager.query).toHaveBeenCalledWith(
          expect.stringContaining("FROM bond_programs"),
          [PROGRAM],
        );
        expect(order).toEqual(["check", "save", "recompute"]);
        expect(mockBondPriceService.recomputeSecurity).toHaveBeenCalledWith(
          "user-1",
          "new-sec",
        );
      });

      it("refuses an instrument that does not exist, writing nothing and recomputing nothing", async () => {
        queryRunnerManager.findOne.mockResolvedValue(null);
        queryRunnerManager.query.mockResolvedValue([]);

        await expect(service.create("user-1", bond)).rejects.toThrow(
          BadRequestException,
        );
        expect(queryRunnerManager.save).not.toHaveBeenCalled();
        expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
      });

      it("refuses a security whose currency differs from the instrument's (INV-PRICE-001)", async () => {
        queryRunnerManager.findOne.mockResolvedValue(null);
        queryRunnerManager.query.mockResolvedValue([{ currency_code: "PLN" }]);

        await expect(
          service.create("user-1", { ...bond, currencyCode: "USD" }),
        ).rejects.toThrow(/recorded in USD.*priced in PLN/);
        expect(queryRunnerManager.save).not.toHaveBeenCalled();
      });

      it("does not look at the catalog for an unlinked security", async () => {
        queryRunnerManager.findOne.mockResolvedValue(null);
        await service.create("user-1", {
          symbol: "MSFT",
          name: "Microsoft",
          currencyCode: "USD",
        });
        expect(queryRunnerManager.query).not.toHaveBeenCalledWith(
          expect.stringContaining("bond_programs"),
          expect.anything(),
        );
        expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
      });

      it("keeps the security when the recompute fails: it is saved, the daily job repairs it", async () => {
        queryRunnerManager.findOne.mockResolvedValue(null);
        queryRunnerManager.query.mockResolvedValue([{ currency_code: "PLN" }]);
        mockBondPriceService.recomputeSecurity.mockRejectedValue(
          new Error("catalog empty"),
        );
        await expect(service.create("user-1", bond)).resolves.toMatchObject({
          bondProgramId: PROGRAM,
        });
      });
    });
    it("creates a new security", async () => {
      queryRunnerManager.findOne.mockResolvedValue(null);

      await service.create("user-1", {
        symbol: "MSFT",
        name: "Microsoft Corp",
        securityType: "STOCK",
        currencyCode: "USD",
      });

      expect(queryRunnerManager.create).toHaveBeenCalledWith(
        Security,
        expect.objectContaining({ symbol: "MSFT", userId: "user-1" }),
      );
      expect(queryRunnerManager.save).toHaveBeenCalled();
    });

    it("normalizes the manual asset allocation onto the new security", async () => {
      queryRunnerManager.findOne.mockResolvedValue(null);

      await service.create("user-1", {
        symbol: "VBAL",
        name: "Vanguard Balanced ETF",
        securityType: "ETF",
        currencyCode: "CAD",
        assetWeightings: [
          { name: " equity ", weight: 0.6 },
          { name: "Equity", weight: 0.0 },
          { name: "Fixed Income", weight: 0.4 },
        ],
      });

      expect(queryRunnerManager.create).toHaveBeenCalledWith(
        Security,
        expect.objectContaining({
          assetWeightings: [
            { name: "equity", weight: 0.6 },
            { name: "Fixed Income", weight: 0.4 },
          ],
        }),
      );
    });

    it("assigns tags atomically when tagIds are provided", async () => {
      queryRunnerManager.findOne.mockResolvedValue(null);
      queryRunnerManager.find.mockResolvedValue([{ id: "tag-1" }]);

      await service.create("user-1", {
        symbol: "AGGG",
        name: "iShares Core Global Aggregate Bond",
        currencyCode: "USD",
        tagIds: ["tag-1"],
      });

      // tagIds must not be persisted as a column on the security row
      expect(queryRunnerManager.create).toHaveBeenCalledWith(
        Security,
        expect.not.objectContaining({ tagIds: expect.anything() }),
      );
      expect(queryRunnerManager.save).toHaveBeenCalledWith(SecurityTag, [
        expect.objectContaining({ securityId: "new-sec", tagId: "tag-1" }),
      ]);
    });

    it("throws ConflictException for duplicate symbol", async () => {
      queryRunnerManager.findOne.mockResolvedValue(mockSecurity);

      await expect(
        service.create("user-1", {
          symbol: "AAPL",
          name: "Apple",
          securityType: "STOCK",
          currencyCode: "USD",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("records action history on create", async () => {
      queryRunnerManager.findOne.mockResolvedValue(null);

      await service.create("user-1", {
        symbol: "MSFT",
        name: "Microsoft Corp.",
        securityType: "STOCK",
        currencyCode: "USD",
      });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "security",
          action: "create",
          description: expect.stringContaining("MSFT"),
        }),
      );
    });
  });

  describe("findAll", () => {
    it("returns only active securities by default", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      const result = await service.findAll("user-1");

      expect(securitiesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isActive: true },
        relations: ["tags"],
        order: { symbol: "ASC" },
      });
      expect(result).toHaveLength(1);
    });

    it("returns all securities when includeInactive is true", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);

      await service.findAll("user-1", true);

      expect(securitiesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        relations: ["tags"],
        order: { symbol: "ASC" },
      });
    });

    it("decorates each security with the close from its latest price row", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      // `pg` hands NUMERIC back as a string; the securities list multiplies this
      // by a share count, so it has to arrive as a number.
      scopedManager.query.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          source: "yahoo_finance",
          close_price: "123.4500000000",
        },
      ]);

      const result = await service.findAll("user-1");

      expect(result[0].lastPrice).toBe(123.45);
      expect(result[0].lastPriceSource).toBe("yahoo_finance");
      expect(scopedManager.query.mock.calls[0][0]).toContain("close_price");
    });

    it("reports no price rather than a zero for a security with none", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.findAll("user-1");

      // A zero here would render as a position worth nothing, which is a
      // measurement nobody made.
      expect(result[0].lastPrice).toBeNull();
      expect(result[0].lastPriceSource).toBeNull();
    });

    it("reports no price when the stored close cannot be read as a number", async () => {
      securitiesRepository.find.mockResolvedValue([mockSecurity]);
      scopedManager.query.mockResolvedValueOnce([
        { security_id: "sec-1", source: "manual", close_price: null },
      ]);

      const result = await service.findAll("user-1");

      expect(result[0].lastPrice).toBeNull();
      // The row exists, so its source is still known.
      expect(result[0].lastPriceSource).toBe("manual");
    });
  });

  describe("findOne", () => {
    it("returns security when found", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);

      const result = await service.findOne("user-1", "sec-1");

      expect(result).toEqual(mockSecurity);
    });

    it("throws NotFoundException when not found", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findBySymbol", () => {
    it("returns security when found", async () => {
      securitiesRepository.findOne.mockResolvedValue(mockSecurity);

      const result = await service.findBySymbol("user-1", "AAPL");

      expect(result).toEqual(mockSecurity);
      expect(securitiesRepository.findOne).toHaveBeenCalledWith({
        where: { symbol: "AAPL", userId: "user-1" },
      });
    });

    it("throws NotFoundException when not found", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(service.findBySymbol("user-1", "FAKE")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    describe("bond link (spec 12.1)", () => {
      const PROGRAM = "11111111-1111-5111-8111-111111111111";
      const OTHER = "22222222-2222-5222-8222-222222222222";
      const pln = {
        ...mockSecurity,
        currencyCode: "PLN",
        securityType: "BOND",
      };
      /**
       * The security as the database holds it: `findOne` returns a copy (the
       * service mutates what it is given) and the row the write locks is the
       * snapshot taken now.
       */
      const serve = (security: Record<string, unknown>) => {
        securitiesRepository.findOne.mockResolvedValue({ ...security });
        const snapshot = {
          bond_program_id: security.bondProgramId ?? null,
          bond_auto_fetch: security.bondAutoFetch ?? false,
          security_type: security.securityType ?? null,
          currency_code: security.currencyCode,
        };
        lockedRowOf = async () => [snapshot];
      };
      /** The catalog and the ledger as the write's transaction sees them. */
      const world = (
        opts: {
          instrumentCurrency?: string | null;
          notBonds?: boolean;
          onQuery?: (sql: string) => void;
        } = {},
      ) =>
        queryRunnerManager.query.mockImplementation(
          queryWith(async (sql: string) => {
            opts.onQuery?.(sql);
            if (/FROM bond_programs/.test(sql))
              return opts.instrumentCurrency === null
                ? []
                : [{ currency_code: opts.instrumentCurrency ?? "PLN" }];
            if (/FROM investment_transactions/.test(sql))
              return opts.notBonds ? [{ "?column?": 1 }] : [];
            return [];
          }),
        );

      it("links a security, checking inside the write transaction before the save, and recomputes after", async () => {
        serve({ ...pln });
        const order: string[] = [];
        world({
          onQuery: (sql) =>
            /bond_programs/.test(sql) &&
            !order.includes("check") &&
            order.push("check"),
        });
        queryRunnerManager.save.mockImplementation(async (a, b) => {
          order.push("save");
          return b ?? a;
        });
        mockBondPriceService.recomputeSecurity.mockImplementation(async () => {
          order.push("recompute");
          return { written: 0, deleted: 0 };
        });

        await service.update("user-1", "sec-1", {
          bondProgramId: PROGRAM,
        });

        expect(order).toEqual(["check", "save", "recompute"]);
        expect(mockBondPriceService.recomputeSecurity).toHaveBeenCalledWith(
          "user-1",
          "sec-1",
        );
      });

      it("refuses a link to a missing instrument or one in another currency, writing nothing", async () => {
        serve({ ...pln });
        world({ instrumentCurrency: null });
        await expect(
          service.update("user-1", "sec-1", { bondProgramId: PROGRAM }),
        ).rejects.toThrow(BadRequestException);

        // A fresh row per request, as the database would return one.
        serve({ ...pln });
        world({ instrumentCurrency: "EUR" });
        await expect(
          service.update("user-1", "sec-1", { bondProgramId: PROGRAM }),
        ).rejects.toThrow(/recorded in PLN.*priced in EUR/);

        expect(queryRunnerManager.save).not.toHaveBeenCalled();
        expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
      });

      it("refuses a currency change of a security that stays linked", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });
        world();

        await expect(
          service.update("user-1", "sec-1", { currencyCode: "USD" }),
        ).rejects.toThrow(/stays in the instrument's currency \(PLN\)/);
        expect(queryRunnerManager.save).not.toHaveBeenCalled();
      });

      it("allows a currency change together with unlinking, and checks nothing", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });

        const result = await service.update("user-1", "sec-1", {
          currencyCode: "USD",
          bondProgramId: null,
        });

        expect(result.bondProgramId).toBeNull();
        expect(queryRunnerManager.query).not.toHaveBeenCalledWith(
          expect.stringContaining("bond_programs"),
          expect.anything(),
        );
        expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
      });

      it("deletes the engine's rows in the write's transaction on unlinking, then refreshes derived state after the commit", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });
        const order: string[] = [];
        mockBondPriceService.clearEnginePrices.mockImplementation(
          async (m: unknown) => {
            expect(m).toBe(queryRunnerManager);
            order.push("clear");
            return { deleted: 3, accountIds: ["acc-1"] };
          },
        );
        queryRunnerManager.save.mockImplementation(async (a, b) => {
          order.push("save");
          return b ?? a;
        });
        mockBondPriceService.publishClearedPrices.mockImplementation(() => {
          order.push("publish");
        });

        await service.update("user-1", "sec-1", { bondProgramId: null });

        expect(order).toEqual(["clear", "save", "publish"]);
        expect(mockBondPriceService.clearEnginePrices).toHaveBeenCalledWith(
          queryRunnerManager,
          "user-1",
          "sec-1",
        );
        expect(mockBondPriceService.publishClearedPrices).toHaveBeenCalledWith(
          "user-1",
          ["acc-1"],
        );
        expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
      });

      it("clears the old instrument's engine rows when the link moves, and prices the new one after the commit", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });
        world();
        await service.update("user-1", "sec-1", { bondProgramId: OTHER });
        expect(mockBondPriceService.clearEnginePrices).toHaveBeenCalledTimes(1);
        expect(mockBondPriceService.recomputeSecurity).toHaveBeenCalledWith(
          "user-1",
          "sec-1",
        );
      });

      it("clears nothing when the link is unchanged", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });
        await service.update("user-1", "sec-1", { name: "Renamed" });
        expect(mockBondPriceService.clearEnginePrices).not.toHaveBeenCalled();
        expect(
          mockBondPriceService.publishClearedPrices,
        ).not.toHaveBeenCalled();
      });

      it("does not check or recompute when an edit leaves the link, the currency and the type alone", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });
        await service.update("user-1", "sec-1", { name: "Renamed" });
        expect(queryRunnerManager.query).not.toHaveBeenCalledWith(
          expect.stringContaining("bond_programs"),
          expect.anything(),
        );
        expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
      });

      it("recomputes when the link moves to another instrument", async () => {
        serve({
          ...pln,
          bondProgramId: PROGRAM,
        });
        world();
        await service.update("user-1", "sec-1", { bondProgramId: OTHER });
        expect(mockBondPriceService.recomputeSecurity).toHaveBeenCalledTimes(1);
      });

      describe("the series of the rows follow the link (INV-BOND-007)", () => {
        const clears = () =>
          queryRunnerManager.query.mock.calls.filter(([q]) =>
            /UPDATE investment_transactions/.test(String(q)),
          );

        it("clears the series outside the new program in the link's own transaction, before the save", async () => {
          serve({ ...pln, bondProgramId: PROGRAM });
          world();
          const order: string[] = [];
          queryRunnerManager.query.mockImplementation(
            queryWith(async (sql: string) => {
              if (/UPDATE investment_transactions/.test(sql))
                order.push("clear");
              if (/FROM bond_programs/.test(sql))
                return [{ currency_code: "PLN" }];
              return [];
            }),
          );
          queryRunnerManager.save.mockImplementation(async (a, b) => {
            order.push("save");
            return b ?? a;
          });
          await service.update("user-1", "sec-1", { bondProgramId: OTHER });
          expect(order).toEqual(["clear", "save"]);
          expect(clears()[0][1]).toEqual(["sec-1", "user-1", OTHER]);
        });

        it("clears every series of a security that is unlinked", async () => {
          serve({ ...pln, bondProgramId: PROGRAM });
          world();
          await service.update("user-1", "sec-1", { bondProgramId: null });
          expect(clears()).toHaveLength(1);
          expect(clears()[0][1]).toEqual(["sec-1", "user-1", null]);
        });

        it("clears nothing while the link is unchanged", async () => {
          serve({ ...pln, bondProgramId: PROGRAM });
          world();
          await service.update("user-1", "sec-1", { name: "Renamed" });
          expect(clears()).toHaveLength(0);
        });

        it("does not touch the rows when the link is refused", async () => {
          serve({ ...pln });
          world({ instrumentCurrency: "EUR" });
          await expect(
            service.update("user-1", "sec-1", { bondProgramId: PROGRAM }),
          ).rejects.toThrow(BadRequestException);
          expect(clears()).toHaveLength(0);
        });
      });

      describe("auto-fetch of the program's new series (spec 2.5)", () => {
        it("is saved with the update and kept when the request does not mention it", async () => {
          serve({ ...pln, bondProgramId: PROGRAM });
          world();
          await service.update("user-1", "sec-1", { bondAutoFetch: true });
          expect(queryRunnerManager.save.mock.calls[0][1].bondAutoFetch).toBe(
            true,
          );

          queryRunnerManager.save.mockClear();
          serve({ ...pln, bondProgramId: PROGRAM, bondAutoFetch: true });
          await service.update("user-1", "sec-1", { name: "Renamed" });
          expect(queryRunnerManager.save.mock.calls[0][1].bondAutoFetch).toBe(
            true,
          );
        });

        it("is switched off by an unlink and cannot be on for an unlinked security", async () => {
          serve({ ...pln, bondProgramId: PROGRAM, bondAutoFetch: true });
          world();
          await service.update("user-1", "sec-1", { bondProgramId: null });
          expect(queryRunnerManager.save.mock.calls[0][1].bondAutoFetch).toBe(
            false,
          );

          queryRunnerManager.save.mockClear();
          serve({ ...pln });
          await service.update("user-1", "sec-1", { bondAutoFetch: true });
          expect(queryRunnerManager.save.mock.calls[0][1].bondAutoFetch).toBe(
            false,
          );
        });

        it("is recorded in the snapshot an undo restores", async () => {
          serve({ ...pln, bondProgramId: PROGRAM, bondAutoFetch: true });
          world();
          await service.update("user-1", "sec-1", { bondAutoFetch: false });
          expect(mockActionHistoryService.record).toHaveBeenCalledWith(
            "user-1",
            expect.objectContaining({
              beforeData: expect.objectContaining({ bondAutoFetch: true }),
            }),
          );
        });
      });

      describe("only a BOND is linked (R8)", () => {
        it("refuses a link on a security of another type", async () => {
          serve({
            ...pln,
            securityType: "ETF",
          });
          world();
          await expect(
            service.update("user-1", "sec-1", { bondProgramId: PROGRAM }),
          ).rejects.toThrow(/Only a security of type Bond/);
          expect(queryRunnerManager.save).not.toHaveBeenCalled();
        });

        it("accepts a link and a change to BOND in the same request", async () => {
          serve({
            ...pln,
            securityType: "ETF",
          });
          world();
          await service.update("user-1", "sec-1", {
            securityType: "BOND",
            bondProgramId: PROGRAM,
          });
          expect(queryRunnerManager.save).toHaveBeenCalled();
        });

        it("refuses changing the type of a linked security away from BOND", async () => {
          serve({
            ...pln,
            bondProgramId: PROGRAM,
          });
          world();
          await expect(
            service.update("user-1", "sec-1", { securityType: "ETF" }),
          ).rejects.toThrow(/Only a security of type Bond/);
          expect(queryRunnerManager.save).not.toHaveBeenCalled();
          expect(mockBondPriceService.clearEnginePrices).not.toHaveBeenCalled();
        });

        it("allows changing the type away from BOND when the same request unlinks", async () => {
          serve({
            ...pln,
            bondProgramId: PROGRAM,
          });
          await service.update("user-1", "sec-1", {
            securityType: "ETF",
            bondProgramId: null,
          });
          expect(queryRunnerManager.save).toHaveBeenCalled();
          expect(mockBondPriceService.clearEnginePrices).toHaveBeenCalled();
        });
      });

      describe("legacy unit quantities (R15)", () => {
        it("refuses a link when a trade's price is far from the face value per bond, writing nothing", async () => {
          serve({ ...pln });
          world({ notBonds: true });
          await expect(
            service.update("user-1", "sec-1", { bondProgramId: PROGRAM }),
          ).rejects.toThrow(/not numbers of bonds/);
          expect(queryRunnerManager.save).not.toHaveBeenCalled();
          expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
        });

        it("reads the band [0.5, 2] x the newest terms' face value, over trades that carry a price", async () => {
          serve({ ...pln });
          let sql = "";
          world({
            onQuery: (q) => {
              if (/FROM investment_transactions/.test(q)) sql = q;
            },
          });
          await service.update("user-1", "sec-1", {
            bondProgramId: PROGRAM,
          });
          expect(sql).toMatch(/faceValue/);
          expect(sql).toMatch(/ORDER BY version DESC/);
          expect(sql).toMatch(
            /t\.price < COALESCE\(f\.face, \$4::numeric\) \* 0\.5/,
          );
          expect(sql).toMatch(
            /t\.price > COALESCE\(f\.face, \$4::numeric\) \* 2/,
          );
          expect(sql).toMatch(/t\.status != 'VOID'/);
          expect(sql).toMatch(/t\.price IS NOT NULL/);
        });

        it("is not read when the link is unchanged (a rename of a linked bond)", async () => {
          serve({
            ...pln,
            bondProgramId: PROGRAM,
          });
          world({ notBonds: true });
          await service.update("user-1", "sec-1", { name: "Renamed" });
          expect(queryRunnerManager.save).toHaveBeenCalled();
        });
      });

      describe("the same instrument in another spelling (R16)", () => {
        it("is no change: nothing is cleared, nothing recomputed, the stored id stays canonical", async () => {
          serve({
            ...pln,
            bondProgramId: PROGRAM,
          });
          world();
          await service.update("user-1", "sec-1", {
            bondProgramId: PROGRAM.toUpperCase(),
          });
          expect(mockBondPriceService.clearEnginePrices).not.toHaveBeenCalled();
          expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
          expect(queryRunnerManager.save.mock.calls[0][1].bondProgramId).toBe(
            PROGRAM,
          );
        });

        it("a new link in capitals is stored in lower case", async () => {
          serve({ ...pln });
          world();
          await service.update("user-1", "sec-1", {
            bondProgramId: PROGRAM.toUpperCase(),
          });
          expect(queryRunnerManager.save.mock.calls[0][1].bondProgramId).toBe(
            PROGRAM,
          );
        });
      });

      describe("the link is decided on the locked row (R32)", () => {
        it("takes the recompute lock, then locks the row FOR UPDATE for its owner, inside the write", async () => {
          serve({ ...pln });
          const sqls: string[] = [];
          world({ onQuery: (q) => sqls.push(q) });
          await service.update("user-1", "sec-1", {
            bondProgramId: PROGRAM,
          });
          const lock = queryRunnerManager.query.mock.calls.find(([q]) =>
            /FOR UPDATE/.test(q),
          )!;
          expect(lock[0]).toMatch(/FROM securities/);
          expect(lock[1]).toEqual(["sec-1", "user-1"]);
          // The recompute lock (advisory) comes before the row lock.
          const texts = queryRunnerManager.query.mock.calls.map(([q]) =>
            String(q),
          );
          expect(
            texts.findIndex((q) => /pg_advisory_xact_lock/.test(q)),
          ).toBeLessThan(texts.findIndex((q) => /FOR UPDATE/.test(q)));
          expect(
            texts.findIndex((q) => /pg_advisory_xact_lock/.test(q)),
          ).toBeGreaterThanOrEqual(0);
        });

        it("a link committed by a concurrent request after this one's read is the baseline: no stale link is put back, and a rename clears nothing", async () => {
          // The read before the transaction saw an unlinked security; by the
          // time the lock is granted another request has linked it.
          serve({ ...pln });
          lockedRowOf = async () => [
            {
              bond_program_id: PROGRAM,
              security_type: "BOND",
              currency_code: "PLN",
            },
          ];
          await service.update("user-1", "sec-1", { name: "Renamed" });
          expect(queryRunnerManager.save.mock.calls[0][1].bondProgramId).toBe(
            PROGRAM,
          );
          expect(mockBondPriceService.clearEnginePrices).not.toHaveBeenCalled();
          expect(mockBondPriceService.recomputeSecurity).not.toHaveBeenCalled();
        });

        it("an unlink decided on a stale read that showed no link still clears the engine's rows", async () => {
          serve({ ...pln });
          lockedRowOf = async () => [
            {
              bond_program_id: PROGRAM,
              security_type: "BOND",
              currency_code: "PLN",
            },
          ];
          await service.update("user-1", "sec-1", { bondProgramId: null });
          expect(mockBondPriceService.clearEnginePrices).toHaveBeenCalledTimes(
            1,
          );
        });

        it("a security that vanished before the lock is a 404", async () => {
          serve({ ...pln });
          lockedRowOf = async () => [];
          await expect(
            service.update("user-1", "sec-1", { name: "x" }),
          ).rejects.toThrow(NotFoundException);
          expect(queryRunnerManager.save).not.toHaveBeenCalled();
        });
      });
    });
    it("updates security fields", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      const result = await service.update("user-1", "sec-1", {
        name: "Apple Inc. Updated",
      });

      expect(result.name).toBe("Apple Inc. Updated");
      expect(queryRunnerManager.save).toHaveBeenCalled();
    });

    it("normalizes a supplied asset allocation and clears it when emptied", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        assetWeightings: [{ name: "Equity", weight: 1 }],
      });

      const updated = await service.update("user-1", "sec-1", {
        assetWeightings: [{ name: "Cash", weight: 0.25 }],
      });
      expect(updated.assetWeightings).toEqual([{ name: "Cash", weight: 0.25 }]);

      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        assetWeightings: [{ name: "Cash", weight: 0.25 }],
      });
      const cleared = await service.update("user-1", "sec-1", {
        assetWeightings: [],
      });
      expect(cleared.assetWeightings).toBeNull();
    });

    it("leaves the asset allocation untouched when the field is omitted", async () => {
      const existing = [{ name: "Equity", weight: 0.8 }];
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        assetWeightings: existing,
      });

      const result = await service.update("user-1", "sec-1", { name: "New" });

      expect(result.assetWeightings).toEqual(existing);
    });

    it("throws ConflictException when updating to existing symbol", async () => {
      securitiesRepository.findOne
        .mockResolvedValueOnce({ ...mockSecurity }) // findOne for the security
        .mockResolvedValueOnce({ id: "sec-2", symbol: "MSFT" }); // conflict check

      await expect(
        service.update("user-1", "sec-1", { symbol: "MSFT" }),
      ).rejects.toThrow(ConflictException);
    });

    it("allows updating to same symbol", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      const result = await service.update("user-1", "sec-1", {
        symbol: "AAPL",
        name: "Updated name",
      });

      expect(result.name).toBe("Updated name");
    });

    it("updates all provided fields explicitly", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", {
        name: "New Name",
        securityType: "ETF",
        exchange: "NYSE",
        currencyCode: "CAD",
        isActive: false,
      });

      const savedSecurity = queryRunnerManager.save.mock.calls[0][1];
      expect(savedSecurity.name).toBe("New Name");
      expect(savedSecurity.securityType).toBe("ETF");
      expect(savedSecurity.exchange).toBe("NYSE");
      expect(savedSecurity.currencyCode).toBe("CAD");
      expect(savedSecurity.isActive).toBe(false);
    });

    it("persists quoteProvider and msnInstrumentId updates", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", {
        quoteProvider: "msn",
        msnInstrumentId: "a1u3p2",
      });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.quoteProvider).toBe("msn");
      expect(saved.msnInstrumentId).toBe("a1u3p2");
    });

    describe("skipPriceUpdates", () => {
      it.each([true, false])(
        "persists an explicit choice of %s",
        async (value) => {
          securitiesRepository.findOne.mockResolvedValue({
            ...mockSecurity,
            skipPriceUpdates: !value,
          });

          await service.update("user-1", "sec-1", { skipPriceUpdates: value });

          const saved = queryRunnerManager.save.mock.calls[0][1];
          expect(saved.skipPriceUpdates).toBe(value);
        },
      );

      it("turns updates back on when a new provider override is picked", async () => {
        securitiesRepository.findOne.mockResolvedValue({
          ...mockSecurity,
          skipPriceUpdates: true,
          quoteProvider: null,
        });

        await service.update("user-1", "sec-1", { quoteProvider: "msn" });

        const saved = queryRunnerManager.save.mock.calls[0][1];
        expect(saved.skipPriceUpdates).toBe(false);
      });

      it("turns updates back on when a new MSN instrument id is entered", async () => {
        securitiesRepository.findOne.mockResolvedValue({
          ...mockSecurity,
          skipPriceUpdates: true,
          quoteProvider: "msn",
          msnInstrumentId: null,
        });

        await service.update("user-1", "sec-1", {
          quoteProvider: "msn",
          msnInstrumentId: "a1u3p2",
        });

        const saved = queryRunnerManager.save.mock.calls[0][1];
        expect(saved.skipPriceUpdates).toBe(false);
      });

      // The form resends every field; an override the row already had is not
      // a new choice and must not undo the user's switch.
      it("keeps updates off when the resent override is unchanged", async () => {
        securitiesRepository.findOne.mockResolvedValue({
          ...mockSecurity,
          skipPriceUpdates: true,
          quoteProvider: "msn",
          msnInstrumentId: "a1u3p2",
        });

        await service.update("user-1", "sec-1", {
          name: "Renamed",
          quoteProvider: "msn",
          msnInstrumentId: "a1u3p2",
        });

        const saved = queryRunnerManager.save.mock.calls[0][1];
        expect(saved.skipPriceUpdates).toBe(true);
      });

      it("backfills prices when updates are turned back on", async () => {
        securitiesRepository.findOne
          .mockResolvedValueOnce({ ...mockSecurity, skipPriceUpdates: true })
          .mockResolvedValueOnce({ ...mockSecurity, skipPriceUpdates: false });

        await service.update("user-1", "sec-1", { skipPriceUpdates: false });

        expect(mockSecurityPriceService.backfillSecurity).toHaveBeenCalledWith(
          expect.objectContaining({ id: mockSecurity.id }),
        );
      });

      it.each([
        [false, false],
        [false, true],
        [true, true],
      ])(
        "does not backfill when the flag goes %s -> %s",
        async (before, after) => {
          securitiesRepository.findOne
            .mockResolvedValueOnce({
              ...mockSecurity,
              skipPriceUpdates: before,
            })
            .mockResolvedValueOnce({
              ...mockSecurity,
              skipPriceUpdates: after,
            });

          await service.update("user-1", "sec-1", { skipPriceUpdates: after });

          expect(
            mockSecurityPriceService.backfillSecurity,
          ).not.toHaveBeenCalled();
        },
      );

      it("lets an explicit choice win over a newly picked provider", async () => {
        securitiesRepository.findOne.mockResolvedValue({
          ...mockSecurity,
          skipPriceUpdates: false,
          quoteProvider: null,
        });

        await service.update("user-1", "sec-1", {
          quoteProvider: "yahoo",
          skipPriceUpdates: true,
        });

        const saved = queryRunnerManager.save.mock.calls[0][1];
        expect(saved.skipPriceUpdates).toBe(true);
      });
    });

    it("clears quoteProvider when explicitly set to null (Use Default)", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        quoteProvider: "msn",
      });

      await service.update("user-1", "sec-1", {
        quoteProvider: null as unknown as undefined,
      });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.quoteProvider).toBeNull();
    });

    it.each([5, null])(
      "persists or clears the price alert threshold %s",
      async (threshold) => {
        securitiesRepository.findOne.mockResolvedValue({
          ...mockSecurity,
          priceAlertPercent: 10,
        });
        await service.update("user-1", "sec-1", {
          priceAlertPercent: threshold,
        });
        expect(queryRunnerManager.save.mock.calls[0][1].priceAlertPercent).toBe(
          threshold,
        );
      },
    );

    it.each([true, false])("persists chart opt-in %s", async (enabled) => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        priceChartEnabled: !enabled,
      });
      await service.update("user-1", "sec-1", { priceChartEnabled: enabled });
      expect(queryRunnerManager.save.mock.calls[0][1].priceChartEnabled).toBe(
        enabled,
      );
    });

    it("persists isFavourite updates", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", { isFavourite: true });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.isFavourite).toBe(true);
    });

    // Regression for issue #1122: the explicit property-mapping block omitted
    // both address fields, so an edit normalised them and then dropped them --
    // the save persisted the unchanged security and the link never stuck.
    it("persists and normalizes website and irWebsite updates (issue #1122)", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", {
        // A bare domain from the form -- the service normalises it to https.
        website: "apple.com",
        irWebsite: "https://investor.apple.com",
      });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.website).toBe("https://apple.com");
      expect(saved.irWebsite).toBe("https://investor.apple.com");
    });

    it("clears website and irWebsite when the form submits them blank", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        website: "https://apple.com",
        irWebsite: "https://investor.apple.com",
      });

      await service.update("user-1", "sec-1", { website: "", irWebsite: "" });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.website).toBeNull();
      expect(saved.irWebsite).toBeNull();
    });

    it("records action history on update", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", { name: "Apple Inc. Updated" });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "security",
          entityId: "sec-1",
          action: "update",
          beforeData: expect.objectContaining({ name: "Apple Inc." }),
          description: expect.stringContaining("AAPL"),
        }),
      );
    });
  });

  describe("getDailyPriceChange", () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-09T12:00:00.000Z"));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("resolves the move of the two newest closes through the shared rule", async () => {
      scopedManager.query.mockResolvedValue([
        { close_price: "110", price_date: "2026-02-09" },
        { close_price: "100", price_date: "2026-02-06" },
      ]);

      const change = await service.getDailyPriceChange("sec-1");

      expect(change).toEqual(
        expect.objectContaining({ dailyChange: 10, priceDate: "2026-02-09" }),
      );
      expect(change?.dailyChangePercent).toBeCloseTo(10);
    });

    it("refuses with null when the newest close is stale", async () => {
      scopedManager.query.mockResolvedValue([
        { close_price: "110", price_date: "2026-02-02" },
        { close_price: "100", price_date: "2026-02-01" },
      ]);

      expect(await service.getDailyPriceChange("sec-1")).toBeNull();
    });
  });

  describe("getFavouriteSecurities", () => {
    // A daily change is only a daily change while its newer close is the
    // session the reader is in, so these cases have a today: the fixtures price
    // Friday 2026-02-06 and Monday 2026-02-09, and the clock is that Monday.
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date("2026-02-09T12:00:00.000Z"));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it("returns an empty array when the user has no favourites", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      const result = await service.getFavouriteSecurities("user-1");

      expect(result).toEqual([]);
      expect(securitiesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isFavourite: true, isActive: true },
        order: { symbol: "ASC" },
      });
      // No price query when there are no favourites.
      expect(scopedManager.query).not.toHaveBeenCalled();
    });

    it("computes the daily change from the two most recent prices", async () => {
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      scopedManager.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "110",
          price_date: "2026-02-09",
          rn: "1",
        },
        {
          security_id: "sec-1",
          close_price: "100",
          price_date: "2026-02-06",
          rn: "2",
        },
      ]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote).toEqual(
        expect.objectContaining({
          securityId: "sec-1",
          symbol: "AAPL",
          currentPrice: 110,
          previousPrice: 100,
          dailyChange: 10,
          priceDate: "2026-02-09",
        }),
      );
      expect(quote.dailyChangePercent).toBeCloseTo(10);
    });

    it("keeps the price but reports no change when the newest close is stale", async () => {
      // The watchlist still knows what this security last traded at. What it
      // does not know is what the day did to it, and last week's move printed
      // under a "daily change" caption is the defect this replaced.
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      scopedManager.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "110",
          price_date: "2026-02-02",
          rn: "1",
        },
        {
          security_id: "sec-1",
          close_price: "100",
          price_date: "2026-01-30",
          rn: "2",
        },
      ]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote.currentPrice).toBe(110);
      expect(quote.dailyChange).toBeNull();
      expect(quote.dailyChangePercent).toBeNull();
      expect(quote.priceDate).toBeNull();
    });

    it("reports an unknown change when fewer than two prices exist", async () => {
      // Never 0: a security that has been priced once has not held its price,
      // it has no previous close to have moved from.
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      scopedManager.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "110",
          price_date: "2026-02-09",
          rn: "1",
        },
      ]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote.currentPrice).toBe(110);
      expect(quote.previousPrice).toBeNull();
      expect(quote.dailyChange).toBeNull();
      expect(quote.dailyChangePercent).toBeNull();
    });

    it("returns a null price when the security has no prices yet", async () => {
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      scopedManager.query.mockResolvedValue([]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote.currentPrice).toBeNull();
      expect(quote.dailyChange).toBeNull();
    });

    it("reports a security that held its price as a zero change", async () => {
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      scopedManager.query.mockResolvedValue([
        {
          security_id: "sec-1",
          close_price: "110",
          price_date: "2026-02-09",
          rn: "1",
        },
        {
          security_id: "sec-1",
          close_price: "110",
          price_date: "2026-02-06",
          rn: "2",
        },
      ]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote.dailyChange).toBe(0);
      expect(quote.dailyChangePercent).toBe(0);
      expect(quote.priceDate).toBe("2026-02-09");
    });
  });

  describe("deactivate", () => {
    it("sets isActive to false when no holdings exist", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      const getCount = jest.fn().mockResolvedValue(0);
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount,
      });

      securitiesRepository.findOneOrFail = jest
        .fn()
        .mockResolvedValue({ ...mockSecurity, isActive: false });

      const result = await service.deactivate("user-1", "sec-1");

      expect(result.isActive).toBe(false);
      // Only the flag is written: a save of the stale read could write back a
      // bond link changed in between.
      expect(securitiesRepository.update).toHaveBeenCalledWith(
        { id: mockSecurity.id, userId: "user-1" },
        { isActive: false },
      );
      expect(securitiesRepository.save).not.toHaveBeenCalled();
      expect(getCount).toHaveBeenCalled();
    });

    it("throws ForbiddenException when security has holdings", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      const getCount = jest.fn().mockResolvedValue(1); // 1 holding exists
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount,
      });

      await expect(service.deactivate("user-1", "sec-1")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.deactivate("user-1", "sec-1")).rejects.toThrow(
        "Cannot deactivate security with active holdings",
      );
      expect(securitiesRepository.save).not.toHaveBeenCalled();
    });

    it("allows deactivating when holdings have zero quantity", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      const getCount = jest.fn().mockResolvedValue(0); // Zero non-zero holdings
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount,
      });

      securitiesRepository.findOneOrFail = jest
        .fn()
        .mockResolvedValue({ ...mockSecurity, isActive: false });

      const result = await service.deactivate("user-1", "sec-1");

      expect(result.isActive).toBe(false);
      expect(securitiesRepository.update).toHaveBeenCalledWith(
        { id: mockSecurity.id, userId: "user-1" },
        { isActive: false },
      );
    });
  });

  describe("activate", () => {
    it("sets isActive to true", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        isActive: false,
      });

      securitiesRepository.findOneOrFail = jest
        .fn()
        .mockResolvedValue({ ...mockSecurity, isActive: true });

      const result = await service.activate("user-1", "sec-1");

      expect(result.isActive).toBe(true);
      expect(securitiesRepository.update).toHaveBeenCalledWith(
        { id: mockSecurity.id, userId: "user-1" },
        { isActive: true },
      );
      expect(securitiesRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes security when no holdings or transactions exist", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(securitiesRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sec-1" }),
      );
    });

    it("throws ForbiddenException when security has holdings", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      holdingsRepository.createQueryBuilder.mockReturnValue({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(2),
      });

      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        "Cannot delete security that has holdings",
      );
    });

    it("throws ForbiddenException when security has investment transactions", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      holdingsRepository.createQueryBuilder.mockReturnValueOnce({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(5),
      });

      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.remove("user-1", "sec-1")).rejects.toThrow(
        "Cannot delete security that has investment transactions",
      );
    });

    it("throws NotFoundException when security does not exist", async () => {
      securitiesRepository.findOne.mockResolvedValue(null);

      await expect(service.remove("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("deletes security and cleans up zero-quantity holdings", async () => {
      const zeroHoldings = [
        { id: "h-1", securityId: "sec-1", accountId: "acc-1", quantity: 0 },
        { id: "h-2", securityId: "sec-1", accountId: "acc-2", quantity: 0 },
      ];
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(zeroHoldings),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHoldings);
      expect(securitiesRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sec-1" }),
      );
    });

    it("does not call holdingsRepository.remove when no zero-quantity holdings exist", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(holdingsRepository.remove).not.toHaveBeenCalled();
      expect(securitiesRepository.remove).toHaveBeenCalled();
    });

    it("allows deletion when only zero-quantity holdings exist (ABS threshold check)", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      const andWhereMock = jest.fn().mockReturnThis();
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: andWhereMock,
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest
            .fn()
            .mockResolvedValue([
              { id: "h-1", securityId: "sec-1", quantity: 0.000000001 },
            ]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      // Verify the ABS threshold filter was applied
      expect(andWhereMock).toHaveBeenCalledWith(
        "ABS(holding.quantity) > :threshold",
        { threshold: 0.00000001 },
      );
      expect(securitiesRepository.remove).toHaveBeenCalled();
    });

    it("records action history on remove", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      securitiesRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.remove = jest.fn().mockResolvedValue(undefined);
      holdingsRepository.createQueryBuilder
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getCount: jest.fn().mockResolvedValue(0),
        })
        .mockReturnValueOnce({
          leftJoin: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue([]),
        });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
      });

      await service.remove("user-1", "sec-1");

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          entityType: "security",
          entityId: "sec-1",
          action: "delete",
          beforeData: expect.objectContaining({ symbol: "AAPL" }),
          description: expect.stringContaining("AAPL"),
        }),
      );
    });
  });

  describe("getSecurityIdsWithTransactions", () => {
    it("returns security IDs that have transactions", async () => {
      const getRawMany = jest
        .fn()
        .mockResolvedValue([{ securityId: "sec-1" }, { securityId: "sec-2" }]);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany,
      });

      const result = await service.getSecurityIdsWithTransactions("user-1");

      expect(result).toEqual(["sec-1", "sec-2"]);
      expect(getRawMany).toHaveBeenCalled();
    });

    it("returns empty array when no transactions exist", async () => {
      const getRawMany = jest.fn().mockResolvedValue([]);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany,
      });

      const result = await service.getSecurityIdsWithTransactions("user-1");

      expect(result).toEqual([]);
    });
  });

  describe("listSecuritiesInAccount", () => {
    it("returns the non-zero holdings of the account as numbers, filtered by account and user", async () => {
      const where = jest.fn().mockReturnThis();
      const andWhere = jest.fn().mockReturnThis();
      const orderBy = jest.fn().mockReturnThis();
      holdingsRepository.createQueryBuilder.mockReturnValue({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        where,
        andWhere,
        orderBy,
        getMany: jest.fn().mockResolvedValue([
          {
            quantity: "12.5",
            averageCost: "10.25",
            security: {
              symbol: "AAPL",
              name: "Apple Inc.",
              securityType: "STOCK",
              exchange: "NASDAQ",
              currencyCode: "USD",
              isFavourite: true,
            },
          },
          {
            quantity: "3",
            averageCost: null,
            security: {
              symbol: "XYZ",
              name: "Xyz",
              securityType: undefined,
              exchange: undefined,
              currencyCode: "CAD",
              isFavourite: false,
            },
          },
        ]),
      });

      const result = await service.listSecuritiesInAccount("user-1", "acc-1");

      expect(where).toHaveBeenCalledWith("h.accountId = :accountId", {
        accountId: "acc-1",
      });
      expect(andWhere).toHaveBeenCalledWith("s.userId = :userId", {
        userId: "user-1",
      });
      expect(andWhere).toHaveBeenCalledWith("h.quantity <> 0");
      expect(orderBy).toHaveBeenCalledWith("s.symbol", "ASC");
      expect(result).toEqual([
        {
          symbol: "AAPL",
          name: "Apple Inc.",
          securityType: "STOCK",
          exchange: "NASDAQ",
          currencyCode: "USD",
          isFavourite: true,
          quantity: 12.5,
          averageCost: 10.25,
        },
        {
          symbol: "XYZ",
          name: "Xyz",
          securityType: null,
          exchange: null,
          currencyCode: "CAD",
          isFavourite: false,
          quantity: 3,
          averageCost: null,
        },
      ]);
    });

    it("returns an empty list when the account holds nothing", async () => {
      holdingsRepository.createQueryBuilder.mockReturnValue({
        innerJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      expect(await service.listSecuritiesInAccount("user-1", "acc-1")).toEqual(
        [],
      );
    });
  });

  describe("search", () => {
    it("searches by symbol and name using query builder", async () => {
      const getMany = jest.fn().mockResolvedValue([mockSecurity]);
      securitiesRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany,
      });

      const result = await service.search("user-1", "AAPL");

      expect(result).toHaveLength(1);
      expect(securitiesRepository.createQueryBuilder).toHaveBeenCalledWith(
        "security",
      );
      expect(getMany).toHaveBeenCalled();
    });

    it("returns empty array when no matches", async () => {
      const result = await service.search("user-1", "ZZZZZ");

      expect(result).toHaveLength(0);
    });
  });

  describe("getCountryOptions", () => {
    const mockCountryQuery = (rows: { name: string | null }[]) => {
      const getRawMany = jest.fn().mockResolvedValue(rows);
      securitiesRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany,
      });
      return getRawMany;
    };

    it("returns the canonical list alphabetically when there are no customs", async () => {
      userPreferencesRepository.findOne.mockResolvedValue(null);
      mockCountryQuery([]);

      const result = await service.getCountryOptions("user-1");

      expect(result).toContain("United States");
      expect(result).toContain("Canada");
      // Alphabetical: Argentina precedes Australia precedes Austria.
      const argentina = result.indexOf("Argentina");
      const australia = result.indexOf("Australia");
      expect(argentina).toBeGreaterThanOrEqual(0);
      expect(argentina).toBeLessThan(australia);
    });

    it("floats the base-currency country to the top", async () => {
      userPreferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "CAD",
      });
      mockCountryQuery([]);

      const result = await service.getCountryOptions("user-1");

      expect(result[0]).toBe("Canada");
      // The remainder stays alphabetical and the base country is not duplicated.
      expect(result.filter((c) => c === "Canada")).toHaveLength(1);
    });

    it("merges custom countries saved on securities and de-dupes canonicals", async () => {
      userPreferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "USD",
      });
      mockCountryQuery([
        { name: "Iceland" }, // custom, not canonical
        { name: "united states" }, // canonical dup (case-insensitive)
        { name: "Other" }, // provider bucket, must be dropped
        { name: "" }, // blank, dropped
        { name: null }, // null, dropped
      ]);

      const result = await service.getCountryOptions("user-1");

      expect(result[0]).toBe("United States");
      expect(result).toContain("Iceland");
      expect(
        result.filter((c) => c.toLowerCase() === "united states"),
      ).toHaveLength(1);
      expect(result).not.toContain("Other");
      expect(result).not.toContain("");
    });

    it("leaves the list alphabetical when the base currency has no single country", async () => {
      userPreferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        defaultCurrency: "EUR",
      });
      mockCountryQuery([]);

      const result = await service.getCountryOptions("user-1");

      // Euro maps to no single country, so the first entry is alphabetical.
      expect(result[0]).toBe("Argentina");
    });
  });

  describe("getAssetOptions", () => {
    const mockAssetQuery = (rows: { name: string | null }[]) => {
      const getRawMany = jest.fn().mockResolvedValue(rows);
      securitiesRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getRawMany,
      });
      return getRawMany;
    };

    it("returns an empty list when the user has saved no asset classes", async () => {
      mockAssetQuery([]);

      expect(await service.getAssetOptions("user-1")).toEqual([]);
    });

    it("returns the user's saved classes alphabetically, de-duped case-insensitively", async () => {
      mockAssetQuery([
        { name: "Equity" },
        { name: "  Cash  " },
        { name: "equity" },
        { name: "Other" }, // catch-all bucket, never offered
        { name: "" },
        { name: null },
      ]);

      const result = await service.getAssetOptions("user-1");

      expect(result).toEqual(["Cash", "Equity"]);
    });

    it("scopes the query to the requesting user", async () => {
      const where = jest.fn().mockReturnThis();
      securitiesRepository.createQueryBuilder.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where,
        andWhere: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      await service.getAssetOptions("user-1");

      expect(where).toHaveBeenCalledWith("s.user_id = :userId", {
        userId: "user-1",
      });
    });
  });

  describe("deleteAssetOption", () => {
    // withScopedDb needs an ambient identity context, and it must be a UUID.
    const userId = "11111111-1111-4111-8111-111111111111";
    const runDelete = (name: string) =>
      withUserContext(userId, () => service.deleteAssetOption(userId, name));

    const mockOwnedSecurities = (securities: unknown[]) => {
      scopedRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(securities),
      });
    };

    it("removes the class from every security that uses it, leaving the rest", async () => {
      mockOwnedSecurities([
        {
          id: "sec-1",
          assetWeightings: [
            { name: "Equity", weight: 0.6 },
            { name: "Cash", weight: 0.1 },
          ],
        },
        {
          id: "sec-2",
          assetWeightings: [{ name: "Bonds", weight: 0.4 }],
        },
      ]);

      const result = await runDelete("Equity");

      // The freed 60% is not re-apportioned: it becomes the computed "Other"
      // remainder for sec-1, which now stores only its 10% cash slice.
      expect(scopedRepository.update).toHaveBeenCalledTimes(1);
      expect(scopedRepository.update).toHaveBeenCalledWith(
        { id: "sec-1", userId },
        { assetWeightings: [{ name: "Cash", weight: 0.1 }] },
      );
      expect(result).toEqual({ name: "Equity", removedFrom: 1 });
    });

    it("matches the name case- and whitespace-insensitively", async () => {
      mockOwnedSecurities([
        {
          id: "sec-1",
          assetWeightings: [{ name: "Fixed  Income", weight: 1 }],
        },
      ]);

      const result = await runDelete("  fixed income ");

      expect(scopedRepository.update).toHaveBeenCalledWith(
        { id: "sec-1", userId },
        { assetWeightings: null },
      );
      expect(result).toEqual({ name: "fixed income", removedFrom: 1 });
    });

    it("clears the column when the deleted class was the only slice", async () => {
      mockOwnedSecurities([
        { id: "sec-1", assetWeightings: [{ name: "Equity", weight: 0.5 }] },
      ]);

      await runDelete("Equity");

      expect(scopedRepository.update).toHaveBeenCalledWith(
        { id: "sec-1", userId },
        { assetWeightings: null },
      );
    });

    it("touches nothing when no security uses the class", async () => {
      mockOwnedSecurities([
        { id: "sec-1", assetWeightings: [{ name: "Cash", weight: 0.2 }] },
      ]);

      const result = await runDelete("Equity");

      expect(scopedRepository.update).not.toHaveBeenCalled();
      expect(result).toEqual({ name: "Equity", removedFrom: 0 });
    });

    it("rejects a blank name without touching the database", async () => {
      await expect(runDelete("   ")).rejects.toThrow(BadRequestException);
      expect(mockDataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe("resolveByTradeSymbol", () => {
    const exact = { ...mockSecurity, id: "sec-a", symbol: "XCNS" };
    const suffixed = { ...mockSecurity, id: "sec-b", symbol: "XCNS.TO" };
    const other = { ...mockSecurity, id: "sec-c", symbol: "XCNS.V" };

    function qb(rows: unknown[]) {
      const builder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(builder);
      return builder;
    }

    it("returns no match for a blank ticker without hitting the database", async () => {
      expect(await service.resolveByTradeSymbol("user-1", " ")).toEqual({
        match: null,
        candidates: [],
      });
      expect(securitiesRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("looks only at symbols (the ticker or the ticker with an exchange suffix), never names, and escapes LIKE metacharacters", async () => {
      const builder = qb([suffixed]);
      await service.resolveByTradeSymbol("user-1", "X_NS");
      const [clause, params] = builder.andWhere.mock.calls.find(([text]) =>
        String(text).includes(":symbol"),
      ) as [string, unknown];
      expect(clause).toMatch(/symbol\) = LOWER\(:symbol\)/);
      expect(clause).not.toMatch(/name/);
      expect(params).toEqual({ symbol: "X_NS", suffixed: "X\\_NS.%" });
      // An inactive security is never the one a new trade is for.
      expect(builder.andWhere).toHaveBeenCalledWith("security.isActive = true");
    });

    it("matches the ticker the broker prints to the user's exchange-suffixed symbol", async () => {
      qb([suffixed]);
      const result = await service.resolveByTradeSymbol("user-1", "xcns");
      expect(result).toEqual({ match: suffixed, candidates: [] });
    });

    it("prefers the exact symbol over suffixed ones", async () => {
      qb([exact, suffixed]);
      const result = await service.resolveByTradeSymbol("user-1", "XCNS");
      expect(result.match).toBe(exact);
    });

    it("does not let an exact symbol win over a listing in another currency: the account's own trades decide", async () => {
      const usd = {
        ...mockSecurity,
        id: "sec-us",
        symbol: "AAPL",
        currencyCode: "USD",
      };
      const cad = {
        ...mockSecurity,
        id: "sec-to",
        symbol: "AAPL.TO",
        currencyCode: "CAD",
      };
      qb([usd, cad]);
      expect(await service.resolveByTradeSymbol("user-1", "AAPL")).toEqual({
        match: null,
        candidates: [usd, cad],
      });

      qb([usd, cad]);
      scopedManager.query.mockImplementationOnce(
        async (sql: string, params: unknown[]) => {
          expect(String(sql)).toContain("it.status != 'VOID'");
          expect(params.slice(0, 2)).toEqual(["user-1", "acc-1"]);
          return [{ security_id: "sec-to" }];
        },
      );
      expect(
        await service.resolveByTradeSymbol("user-1", "AAPL", "acc-1"),
      ).toEqual({ match: cad, candidates: [] });
    });

    it("narrows the listings to the currency the email names, and ignores a currency none trades in", async () => {
      const usd = {
        ...mockSecurity,
        id: "sec-us",
        symbol: "SHOP",
        currencyCode: "USD",
      };
      const cad = {
        ...mockSecurity,
        id: "sec-to",
        symbol: "SHOP.TO",
        currencyCode: "CAD",
      };
      qb([usd, cad]);
      expect(
        await service.resolveByTradeSymbol("user-1", "SHOP", undefined, "cad"),
      ).toEqual({ match: cad, candidates: [] });
      qb([usd, cad]);
      expect(
        await service.resolveByTradeSymbol("user-1", "SHOP", undefined, "EUR"),
      ).toEqual({ match: null, candidates: [usd, cad] });
    });

    it("lets an exact symbol win over listings in its own currency", async () => {
      const a = {
        ...mockSecurity,
        id: "sec-a",
        symbol: "XCNS",
        currencyCode: "CAD",
      };
      const b = {
        ...mockSecurity,
        id: "sec-b",
        symbol: "XCNS.TO",
        currencyCode: "CAD",
      };
      qb([a, b]);
      expect((await service.resolveByTradeSymbol("user-1", "XCNS")).match).toBe(
        a,
      );
    });

    it("never guesses between several suffixed securities", async () => {
      qb([suffixed, other]);
      const result = await service.resolveByTradeSymbol("user-1", "XCNS");
      expect(result).toEqual({ match: null, candidates: [suffixed, other] });
    });

    it("finds nothing for an unknown ticker", async () => {
      qb([]);
      const result = await service.resolveByTradeSymbol("user-1", "NOPE");
      expect(result).toEqual({ match: null, candidates: [] });
    });
  });

  describe("resolveBySymbolOrName", () => {
    const secA = {
      ...mockSecurity,
      id: "sec-a",
      symbol: "AAPL",
      name: "Apple Inc.",
    };
    const secB = {
      ...mockSecurity,
      id: "sec-b",
      symbol: "AAPL.L",
      name: "Apple London",
    };

    // Build a chainable query-builder stub returning the given getOne/getMany.
    function qb(result: { getOne?: unknown; getMany?: unknown[] }) {
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(result.getOne ?? null),
        getMany: jest.fn().mockResolvedValue(result.getMany ?? []),
      };
    }

    it("returns no match for a blank query without hitting the database", async () => {
      const result = await service.resolveBySymbolOrName("user-1", "   ");
      expect(result).toEqual({ match: null, candidates: [] });
      expect(securitiesRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("matches by exact symbol first", async () => {
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({ getOne: secA }),
      );
      const result = await service.resolveBySymbolOrName("user-1", "aapl");
      expect(result.match).toBe(secA);
      expect(result.candidates).toEqual([]);
      // Resolved on the symbol step -- no name/partial queries needed.
      expect(securitiesRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("falls back to a unique exact-name match", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(qb({ getMany: [secA] }));
      const result = await service.resolveBySymbolOrName(
        "user-1",
        "Apple Inc.",
      );
      expect(result.match).toBe(secA);
      expect(result.candidates).toEqual([]);
    });

    it("returns candidates when a name is ambiguous", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(qb({ getMany: [secA, secB] }));
      const result = await service.resolveBySymbolOrName("user-1", "Apple");
      expect(result.match).toBeNull();
      expect(result.candidates).toEqual([secA, secB]);
    });

    it("resolves a unique substring match", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(qb({ getMany: [] }))
        .mockReturnValueOnce(qb({ getMany: [secA] }));
      const result = await service.resolveBySymbolOrName("user-1", "appl");
      expect(result.match).toBe(secA);
    });

    it("returns candidates for an ambiguous substring match", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(qb({ getMany: [] }))
        .mockReturnValueOnce(qb({ getMany: [secA, secB] }));
      const result = await service.resolveBySymbolOrName("user-1", "app");
      expect(result.match).toBeNull();
      expect(result.candidates).toEqual([secA, secB]);
    });

    it("returns no match when nothing matches at all", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(qb({ getMany: [] }))
        .mockReturnValueOnce(qb({ getMany: [] }));
      const result = await service.resolveBySymbolOrName("user-1", "ZZZZ");
      expect(result).toEqual({ match: null, candidates: [] });
    });
  });

  describe("manage security previews", () => {
    const sec = {
      ...mockSecurity,
      id: "sec-a",
      symbol: "AAPL",
      name: "Apple Inc.",
      securityType: "STOCK",
      exchange: "NASDAQ",
      currencyCode: "USD",
      isFavourite: false,
    };

    function qb(result: { getOne?: unknown; getMany?: unknown[] }) {
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(result.getOne ?? null),
        getMany: jest.fn().mockResolvedValue(result.getMany ?? []),
      };
    }

    it("previewUpdateSecurity merges supplied fields over the resolved security", async () => {
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({ getOne: sec }),
      );

      const preview = await service.previewUpdateSecurity("user-1", {
        query: "AAPL",
        securityType: "ETF",
        isFavourite: true,
      });

      expect(preview).toEqual({
        securityId: "sec-a",
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "ETF",
        exchange: "NASDAQ",
        currencyCode: "USD",
        isFavourite: true,
        countryWeightings: null,
        assetWeightings: null,
      });
    });

    describe("previewUpdateSecurity of a bond-linked security (R18)", () => {
      const PROGRAM = "11111111-1111-5111-8111-111111111111";
      const linked = {
        ...sec,
        securityType: "BOND",
        currencyCode: "PLN",
        bondProgramId: PROGRAM,
      };
      const catalog = (currency: string | null) =>
        queryRunnerManager.query.mockImplementation(async (sql: string) =>
          /FROM bond_programs/.test(sql)
            ? currency === null
              ? []
              : [{ currency_code: currency }]
            : [],
        );

      it("refuses a currency change the commit would refuse, with the same message, before any confirmation", async () => {
        securitiesRepository.createQueryBuilder.mockReturnValueOnce(
          qb({ getOne: linked }),
        );
        catalog("PLN");
        await expect(
          service.previewUpdateSecurity("user-1", {
            query: "AAPL",
            currencyCode: "EUR",
          }),
        ).rejects.toThrow(/stays in the instrument's currency \(PLN\)/);
      });

      it("refuses a change of the type away from BOND", async () => {
        securitiesRepository.createQueryBuilder.mockReturnValueOnce(
          qb({ getOne: linked }),
        );
        catalog("PLN");
        await expect(
          service.previewUpdateSecurity("user-1", {
            query: "AAPL",
            securityType: "ETF",
          }),
        ).rejects.toThrow(/Only a security of type Bond/);
      });

      it("accepts an edit that leaves the currency and the type alone, without reading the catalog", async () => {
        securitiesRepository.createQueryBuilder.mockReturnValueOnce(
          qb({ getOne: linked }),
        );
        queryRunnerManager.query.mockClear();
        const preview = await service.previewUpdateSecurity("user-1", {
          query: "AAPL",
          isFavourite: true,
          currencyCode: "PLN",
          securityType: "BOND",
        });
        expect(preview.currencyCode).toBe("PLN");
        expect(queryRunnerManager.query).not.toHaveBeenCalled();
      });

      it("leaves an unlinked security alone", async () => {
        securitiesRepository.createQueryBuilder.mockReturnValueOnce(
          qb({ getOne: sec }),
        );
        const preview = await service.previewUpdateSecurity("user-1", {
          query: "AAPL",
          currencyCode: "EUR",
        });
        expect(preview.currencyCode).toBe("EUR");
      });
    });

    it("previewUpdateSecurity normalizes supplied country weightings to decimals", async () => {
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({ getOne: sec }),
      );

      const preview = await service.previewUpdateSecurity("user-1", {
        query: "AAPL",
        countryWeightings: [
          { name: "United States", weight: 0.6 },
          { name: "Canada", weight: 0.25 },
        ],
      });

      expect(preview.countryWeightings).toEqual([
        { name: "United States", weight: 0.6 },
        { name: "Canada", weight: 0.25 },
      ]);
    });

    it("previewUpdateSecurity normalizes supplied asset weightings and keeps stored ones otherwise", async () => {
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({ getOne: sec }),
      );

      const preview = await service.previewUpdateSecurity("user-1", {
        query: "AAPL",
        assetWeightings: [
          { name: " equity ", weight: 0.6 },
          { name: "Equity", weight: 0.1 },
        ],
      });

      // Free-text names are kept as typed; case-only duplicates are summed.
      expect(preview.assetWeightings).toEqual([
        { name: "equity", weight: 0.7 },
      ]);

      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({
          getOne: { ...sec, assetWeightings: [{ name: "Cash", weight: 0.2 }] },
        }),
      );
      const untouched = await service.previewUpdateSecurity("user-1", {
        query: "AAPL",
        isFavourite: true,
      });
      expect(untouched.assetWeightings).toEqual([
        { name: "Cash", weight: 0.2 },
      ]);
    });

    it("previewUpdateSecurity keeps current values when no change is supplied", async () => {
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({ getOne: sec }),
      );

      const preview = await service.previewUpdateSecurity("user-1", {
        query: "AAPL",
      });

      expect(preview.securityType).toBe("STOCK");
      expect(preview.exchange).toBe("NASDAQ");
      expect(preview.isFavourite).toBe(false);
    });

    it("previewDeleteSecurity resolves the security by symbol", async () => {
      securitiesRepository.createQueryBuilder.mockReturnValueOnce(
        qb({ getOne: sec }),
      );

      const preview = await service.previewDeleteSecurity("user-1", {
        query: "AAPL",
      });

      expect(preview).toEqual({
        securityId: "sec-a",
        symbol: "AAPL",
        name: "Apple Inc.",
      });
    });

    it("throws NotFound when the security cannot be resolved", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(qb({ getMany: [] }))
        .mockReturnValueOnce(qb({ getMany: [] }));

      await expect(
        service.previewDeleteSecurity("user-1", { query: "ZZZZ" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequest when the reference is ambiguous", async () => {
      securitiesRepository.createQueryBuilder
        .mockReturnValueOnce(qb({ getOne: null }))
        .mockReturnValueOnce(
          qb({
            getMany: [
              { ...sec, id: "s1", symbol: "AAPL" },
              { ...sec, id: "s2", symbol: "AAPL.L" },
            ],
          }),
        );

      await expect(
        service.previewUpdateSecurity("user-1", { query: "Apple" }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("normalizeAllocationWeightings", () => {
    it("returns null for empty / undefined input", () => {
      expect(service.normalizeAllocationWeightings(undefined)).toBeNull();
      expect(service.normalizeAllocationWeightings([])).toBeNull();
    });

    it("snaps country names, drops blanks, and sorts by weight desc", () => {
      const result = service.normalizeAllocationWeightings([
        { name: "usa", weight: 0.3 },
        { name: "  Canada ", weight: 0.5 },
        { name: "", weight: 0.2 },
      ]);
      expect(result).toEqual([
        { name: "Canada", weight: 0.5 },
        { name: "United States", weight: 0.3 },
      ]);
    });

    it("sums duplicate names and drops non-positive weights", () => {
      const result = service.normalizeAllocationWeightings([
        { name: "United States", weight: 0.2 },
        { name: "USA", weight: 0.1 },
        { name: "Canada", weight: 0 },
      ]);
      expect(result).toEqual([{ name: "United States", weight: 0.3 }]);
    });

    it("drops a provider 'Other' slice so it folds into the computed remainder", () => {
      const result = service.normalizeAllocationWeightings([
        { name: "United States", weight: 0.6 },
        { name: "Other", weight: 0.1 },
        { name: "OTHER", weight: 0.05 },
      ]);
      // No "Other" country is stored; its weight becomes the implicit remainder.
      expect(result).toEqual([{ name: "United States", weight: 0.6 }]);
    });

    it("allows a sub-100% total (the remainder is Other)", () => {
      const result = service.normalizeAllocationWeightings([
        { name: "United States", weight: 0.6 },
      ]);
      expect(result).toEqual([{ name: "United States", weight: 0.6 }]);
    });

    it("throws when the weights total more than 100%", () => {
      expect(() =>
        service.normalizeAllocationWeightings([
          { name: "United States", weight: 0.7 },
          { name: "Canada", weight: 0.5 },
        ]),
      ).toThrow(BadRequestException);
    });
  });

  describe("normalizeAssetWeightings", () => {
    it("returns null for empty / undefined input", () => {
      expect(service.normalizeAssetWeightings(undefined)).toBeNull();
      expect(service.normalizeAssetWeightings([])).toBeNull();
    });

    it("keeps free-text names as typed, only tidying whitespace", () => {
      const result = service.normalizeAssetWeightings([
        { name: "  Fixed  Income ", weight: 0.4 },
        { name: "Real Estate", weight: 0.1 },
      ]);
      expect(result).toEqual([
        { name: "Fixed Income", weight: 0.4 },
        { name: "Real Estate", weight: 0.1 },
      ]);
    });

    it("sums names that differ only by case under the first spelling", () => {
      const result = service.normalizeAssetWeightings([
        { name: "Equity", weight: 0.5 },
        { name: "equity", weight: 0.2 },
      ]);
      expect(result).toEqual([{ name: "Equity", weight: 0.7 }]);
    });

    it("drops an 'Other' slice so it folds into the computed remainder", () => {
      const result = service.normalizeAssetWeightings([
        { name: "Equity", weight: 0.6 },
        { name: "Other", weight: 0.4 },
      ]);
      expect(result).toEqual([{ name: "Equity", weight: 0.6 }]);
    });

    it("throws when the weights total more than 100%", () => {
      expect(() =>
        service.normalizeAssetWeightings([
          { name: "Equity", weight: 0.7 },
          { name: "Cash", weight: 0.5 },
        ]),
      ).toThrow(BadRequestException);
    });
  });

  describe("setSecurityTags", () => {
    it("validates ownership, then replaces the tag set", async () => {
      queryRunnerManager.find.mockResolvedValue([
        { id: "tag-1" },
        { id: "tag-2" },
      ]);

      await service.setSecurityTags(
        "sec-1",
        ["tag-1", "tag-2"],
        "user-1",
        scopedManager as never,
      );

      expect(queryRunnerManager.delete).toHaveBeenCalledWith(SecurityTag, {
        securityId: "sec-1",
      });
      expect(queryRunnerManager.save).toHaveBeenCalledWith(SecurityTag, [
        expect.objectContaining({ securityId: "sec-1", tagId: "tag-1" }),
        expect.objectContaining({ securityId: "sec-1", tagId: "tag-2" }),
      ]);
    });

    it("throws when a tag does not belong to the user", async () => {
      queryRunnerManager.find.mockResolvedValue([{ id: "tag-1" }]);

      await expect(
        service.setSecurityTags("sec-1", ["tag-1", "tag-missing"], "user-1"),
      ).rejects.toThrow(NotFoundException);
    });

    it("clears all tags when given an empty list", async () => {
      await service.setSecurityTags("sec-1", [], "user-1");

      expect(queryRunnerManager.delete).toHaveBeenCalledWith(SecurityTag, {
        securityId: "sec-1",
      });
      expect(queryRunnerManager.save).not.toHaveBeenCalledWith(
        SecurityTag,
        expect.anything(),
      );
    });
  });

  describe("getSuggestedDescription", () => {
    it("returns the Yahoo profile description and website together", async () => {
      // One call for both: the website rides along in the `summaryProfile` the
      // description already needed, so there is no second request to make.
      mockYahooFinanceService.fetchSecurityProfile.mockResolvedValue({
        description: "Apple Inc. designs phones.",
        website: "https://www.apple.com",
      });

      const result = await service.getSuggestedDescription("AAPL", "NASDAQ");

      expect(mockYahooFinanceService.fetchSecurityProfile).toHaveBeenCalledWith(
        "AAPL",
        "NASDAQ",
      );
      expect(result).toEqual({
        symbol: "AAPL",
        description: "Apple Inc. designs phones.",
        website: "https://www.apple.com",
      });
    });

    it("returns nulls when Yahoo has nothing", async () => {
      mockYahooFinanceService.fetchSecurityProfile.mockResolvedValue({
        description: null,
        website: null,
      });

      const result = await service.getSuggestedDescription("XYZ");

      expect(result).toEqual({
        symbol: "XYZ",
        description: null,
        website: null,
      });
    });

    it("carries a null website for a fund, where Yahoo publishes no URL", async () => {
      mockYahooFinanceService.fetchSecurityProfile.mockResolvedValue({
        description: "iShares Core MSCI World (BlackRock). TER 0.20%.",
        website: null,
      });

      const result = await service.getSuggestedDescription("IWDA", "AMS");

      expect(result.description).toContain("iShares");
      expect(result.website).toBeNull();
    });
  });

  describe("findByTag", () => {
    it("returns the user's securities carrying a tag", async () => {
      const tagged = [{ id: "sec-1", symbol: "AGGG" }];
      securitiesRepository.createQueryBuilder.mockReturnValue({
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(tagged),
      });

      const result = await service.findByTag("user-1", "tag-1");

      expect(result).toEqual(tagged);
    });
  });

  describe("update with description and tags", () => {
    it("persists the description and replaces the tag set", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });
      queryRunnerManager.find.mockResolvedValue([{ id: "tag-1" }]);

      await service.update("user-1", "sec-1", {
        description: "Global aggregate bond ETF.",
        tagIds: ["tag-1"],
      });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.description).toBe("Global aggregate bond ETF.");
      expect(queryRunnerManager.save).toHaveBeenCalledWith(SecurityTag, [
        expect.objectContaining({ securityId: "sec-1", tagId: "tag-1" }),
      ]);
    });
  });

  describe("bond price recompute entry points", () => {
    it("recomputeBondPricesAfterWrite hands the ids to the price service, which ignores the ones that are not linked", async () => {
      mockBondPriceService.recomputeLinkedSecurities = jest
        .fn()
        .mockResolvedValue(undefined);
      await service.recomputeBondPricesAfterWrite("user-1", ["a", null, "b"]);
      expect(
        mockBondPriceService.recomputeLinkedSecurities,
      ).toHaveBeenCalledWith("user-1", ["a", null, "b"]);
    });

    it("recomputeBondPricesOfAccounts finds the linked securities traded in the accounts, owner-scoped", async () => {
      mockBondPriceService.recomputeLinkedSecurities = jest
        .fn()
        .mockResolvedValue(undefined);
      queryRunnerManager.query.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
      await service.recomputeBondPricesOfAccounts("user-1", ["acc-1"]);
      const [sql, params] = queryRunnerManager.query.mock.calls[0];
      expect(sql).toMatch(/s\.bond_program_id IS NOT NULL/);
      expect(sql).toMatch(/s\.user_id = \$1/);
      expect(params).toEqual(["user-1", ["acc-1"]]);
      expect(
        mockBondPriceService.recomputeLinkedSecurities,
      ).toHaveBeenCalledWith("user-1", ["s1", "s2"]);
    });

    it("recomputeBondPricesOfAccounts does nothing for no accounts", async () => {
      mockBondPriceService.recomputeLinkedSecurities = jest.fn();
      await service.recomputeBondPricesOfAccounts("user-1", []);
      expect(queryRunnerManager.query).not.toHaveBeenCalled();
    });

    it("recomputeLinkedPrices recomputes each selected linked security and reports a failure as a failed row", async () => {
      mockBondPriceService.recomputeSecurity
        .mockResolvedValueOnce({ written: 1, deleted: 0 })
        .mockRejectedValueOnce(new Error("no rates"));
      const result = await service.recomputeLinkedPrices("user-1", [
        { id: "s1", symbol: "EDO1036" },
        { id: "s2", symbol: "TOS1029" },
      ]);
      expect(result).toEqual({
        updated: 1,
        failed: 1,
        results: [
          { symbol: "EDO1036", success: true },
          { symbol: "TOS1029", success: false, error: "no rates" },
        ],
      });
    });

    describe("recomputeLinkedPrices fetches the program's offer first", () => {
      const selection = [
        { id: "s1", symbol: "EDO1036" },
        { id: "s2", symbol: "EDO1035" },
      ];
      const programRows = (country = "PL") => [
        { id: "s1", issuer_country_code: country, program_code: "EDO" },
        { id: "s2", issuer_country_code: country, program_code: "EDO" },
      ];

      it("fetches once per program, before the recompute", async () => {
        queryRunnerManager.query.mockImplementation(
          queryWith(async () => programRows()),
        );
        const order: string[] = [];
        mockBondSeriesService.fetchProgramOffer.mockImplementation(async () => {
          order.push("fetch");
          return { listed: 1, stored: 1, alreadyStored: 0, failed: 0 };
        });
        mockBondPriceService.recomputeSecurity.mockImplementation(async () => {
          order.push("recompute");
          return { written: 1, deleted: 0 };
        });
        const result = await service.recomputeLinkedPrices("user-1", selection);
        expect(mockBondSeriesService.fetchProgramOffer).toHaveBeenCalledTimes(
          1,
        );
        expect(mockBondSeriesService.fetchProgramOffer).toHaveBeenCalledWith(
          "PL",
          "EDO",
        );
        expect(order).toEqual(["fetch", "recompute", "recompute"]);
        expect(result.updated).toBe(2);
        expect(result.failed).toBe(0);
      });

      it("a failed fetch still recomputes and is reported on the row", async () => {
        queryRunnerManager.query.mockImplementation(
          queryWith(async () => programRows()),
        );
        mockBondSeriesService.fetchProgramOffer.mockRejectedValue(
          new Error("source down"),
        );
        const result = await service.recomputeLinkedPrices("user-1", selection);
        expect(mockBondPriceService.recomputeSecurity).toHaveBeenCalledTimes(2);
        expect(result.updated).toBe(0);
        expect(result.failed).toBe(2);
        expect(result.results[0]).toMatchObject({
          symbol: "EDO1036",
          success: false,
          error: expect.stringContaining("source down"),
        });
      });

      it("an offer where everything failed is reported, a country with no fetch is not", async () => {
        queryRunnerManager.query.mockImplementation(
          queryWith(async () => programRows()),
        );
        mockBondSeriesService.fetchProgramOffer.mockResolvedValue({
          listed: 2,
          stored: 0,
          alreadyStored: 0,
          failed: 2,
        });
        const failedRun = await service.recomputeLinkedPrices(
          "user-1",
          selection,
        );
        expect(failedRun.failed).toBe(2);

        mockBondSeriesService.fetchProgramOffer.mockRejectedValue(
          new SeriesFetchError("SERIES_FETCH_UNSUPPORTED", { country: "DE" }),
        );
        const skipped = await service.recomputeLinkedPrices(
          "user-1",
          selection,
        );
        expect(skipped).toMatchObject({ updated: 2, failed: 0 });
        expect(mockBondPriceService.recomputeSecurity).toHaveBeenCalled();
      });
    });

    describe("recomputeLinkedPrices judges the whole refresh pass", () => {
      const selection = [{ id: "s1", symbol: "EDO1036" }];
      const history = (stored: number, failed: number) => ({
        candidates: 8,
        alreadyStored: 0,
        stored,
        notPublished: 0,
        failed,
        stoppedEarly: false,
        remaining: 0,
      });
      const run = async (offer: object) => {
        queryRunnerManager.query.mockImplementation(
          queryWith(async () => [
            { id: "s1", issuer_country_code: "PL", program_code: "EDO" },
          ]),
        );
        mockBondSeriesService.fetchProgramOffer.mockResolvedValue(offer);
        return service.recomputeLinkedPrices("user-1", selection);
      };

      it("is a success when the listing failed but the history stored series", async () => {
        const result = await run({
          listed: 0,
          stored: 0,
          alreadyStored: 0,
          failed: 1,
          history: history(3, 0),
        });
        expect(result).toMatchObject({ updated: 1, failed: 0 });
      });

      it("is a success when the offer stored some and another series failed", async () => {
        const result = await run({
          listed: 2,
          stored: 1,
          alreadyStored: 0,
          failed: 1,
          history: history(0, 0),
        });
        expect(result).toMatchObject({ updated: 1, failed: 0 });
      });

      it("is a failure only when nothing of the pass succeeded and something failed", async () => {
        const result = await run({
          listed: 0,
          stored: 0,
          alreadyStored: 0,
          failed: 1,
          history: history(0, 2),
        });
        expect(result).toMatchObject({ updated: 0, failed: 1 });
        expect(result.results[0]).toMatchObject({
          success: false,
          error: "The current EDO offer could not be fetched",
        });
      });

      it("is a success when nothing failed, even if nothing was stored", async () => {
        const result = await run({
          listed: 0,
          stored: 0,
          alreadyStored: 0,
          failed: 0,
          history: history(0, 0),
        });
        expect(result).toMatchObject({ updated: 1, failed: 0 });
      });
    });

    it("create refuses a link on a security that is not of type BOND", async () => {
      queryRunnerManager.findOne.mockResolvedValue(null);
      queryRunnerManager.query.mockResolvedValue([{ currency_code: "PLN" }]);
      await expect(
        service.create("user-1", {
          symbol: "X",
          name: "X",
          securityType: "ETF",
          currencyCode: "PLN",
          bondProgramId: "11111111-1111-5111-8111-111111111111",
        }),
      ).rejects.toThrow(/Only a security of type Bond/);
      expect(queryRunnerManager.save).not.toHaveBeenCalled();
    });

    describe("create links to a program and takes the auto-fetch switch", () => {
      const PROGRAM = "11111111-1111-5111-8111-111111111111";
      const bond = {
        symbol: "EDO",
        name: "EDO",
        securityType: "BOND",
        currencyCode: "PLN",
      };
      beforeEach(() => {
        queryRunnerManager.findOne.mockResolvedValue(null);
        queryRunnerManager.query.mockResolvedValue([{ currency_code: "PLN" }]);
        queryRunnerManager.save.mockImplementation(async (a, b) => b ?? a);
      });

      it("stores the program id lower-cased, with auto-fetch as asked, after the program check", async () => {
        await service.create("user-1", {
          ...bond,
          bondProgramId: PROGRAM.toUpperCase(),
          bondAutoFetch: true,
        });
        expect(queryRunnerManager.create.mock.calls[0][1]).toMatchObject({
          bondProgramId: PROGRAM,
          bondAutoFetch: true,
        });
        expect(queryRunnerManager.query).toHaveBeenCalledWith(
          expect.stringContaining("FROM bond_programs"),
          [PROGRAM],
        );
      });

      it("refuses a program that does not exist, writing nothing", async () => {
        queryRunnerManager.query.mockResolvedValue([]);
        await expect(
          service.create("user-1", { ...bond, bondProgramId: PROGRAM }),
        ).rejects.toThrow(/does not exist/);
        expect(queryRunnerManager.save).not.toHaveBeenCalled();
      });

      it("refuses a program in another currency", async () => {
        await expect(
          service.create("user-1", {
            ...bond,
            currencyCode: "EUR",
            bondProgramId: PROGRAM,
          }),
        ).rejects.toThrow(/recorded in EUR.*priced in PLN/);
      });

      it("keeps auto-fetch off for a security that is not linked, whatever was sent", async () => {
        await service.create("user-1", { ...bond, bondAutoFetch: true });
        expect(queryRunnerManager.create.mock.calls[0][1]).toMatchObject({
          bondAutoFetch: false,
        });
      });
    });
  });
});
