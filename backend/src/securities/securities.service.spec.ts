import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { SecuritiesService } from "./securities.service";
import { Security } from "./entities/security.entity";
import { SecurityTag } from "./entities/security-tag.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { SecurityPriceService } from "./security-price.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { ActionHistoryService } from "../action-history/action-history.service";

describe("SecuritiesService", () => {
  let service: SecuritiesService;
  let securitiesRepository: Record<string, any>;
  let securityTagsRepository: Record<string, jest.Mock>;
  let holdingsRepository: Record<string, jest.Mock>;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let mockSecurityPriceService: Record<string, jest.Mock>;
  let mockActionHistoryService: Record<string, jest.Mock>;
  let mockYahooFinanceService: Record<string, jest.Mock>;
  let queryRunnerManager: Record<string, jest.Mock>;
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

  beforeEach(async () => {
    securitiesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-sec" })),
      save: jest.fn().mockImplementation((data) => data),
      // `findAll` decorates results with lastPriceSource via manager.query.
      manager: { query: jest.fn().mockResolvedValue([]) },
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    holdingsRepository = {
      createQueryBuilder: jest.fn(() => ({
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
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

    mockYahooFinanceService = {
      fetchSecurityProfileDescription: jest.fn().mockResolvedValue(null),
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

    mockDataSource = {
      manager: queryRunnerManager,
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: queryRunnerManager,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecuritiesService,
        {
          provide: getRepositoryToken(Security),
          useValue: securitiesRepository,
        },
        {
          provide: getRepositoryToken(SecurityTag),
          useValue: securityTagsRepository,
        },
        {
          provide: getRepositoryToken(Holding),
          useValue: holdingsRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTransactionsRepository,
        },
        {
          provide: SecurityPriceService,
          useValue: mockSecurityPriceService,
        },
        {
          provide: YahooFinanceService,
          useValue: mockYahooFinanceService,
        },
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<SecuritiesService>(SecuritiesService);
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
    it("updates security fields", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      const result = await service.update("user-1", "sec-1", {
        name: "Apple Inc. Updated",
      });

      expect(result.name).toBe("Apple Inc. Updated");
      expect(queryRunnerManager.save).toHaveBeenCalled();
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

    it("persists isFavourite updates", async () => {
      securitiesRepository.findOne.mockResolvedValue({ ...mockSecurity });

      await service.update("user-1", "sec-1", { isFavourite: true });

      const saved = queryRunnerManager.save.mock.calls[0][1];
      expect(saved.isFavourite).toBe(true);
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

  describe("getFavouriteSecurities", () => {
    it("returns an empty array when the user has no favourites", async () => {
      securitiesRepository.find.mockResolvedValue([]);

      const result = await service.getFavouriteSecurities("user-1");

      expect(result).toEqual([]);
      expect(securitiesRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1", isFavourite: true, isActive: true },
        order: { symbol: "ASC" },
      });
      // No price query when there are no favourites.
      expect(securitiesRepository.manager.query).not.toHaveBeenCalled();
    });

    it("computes the daily change from the two most recent prices", async () => {
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      securitiesRepository.manager.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "110", rn: "1" },
        { security_id: "sec-1", close_price: "100", rn: "2" },
      ]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote).toEqual(
        expect.objectContaining({
          securityId: "sec-1",
          symbol: "AAPL",
          currentPrice: 110,
          previousPrice: 100,
          dailyChange: 10,
        }),
      );
      expect(quote.dailyChangePercent).toBeCloseTo(10);
    });

    it("reports a zero change when fewer than two prices exist", async () => {
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      securitiesRepository.manager.query.mockResolvedValue([
        { security_id: "sec-1", close_price: "110", rn: "1" },
      ]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote.currentPrice).toBe(110);
      expect(quote.previousPrice).toBeNull();
      expect(quote.dailyChange).toBe(0);
      expect(quote.dailyChangePercent).toBe(0);
    });

    it("returns a null price when the security has no prices yet", async () => {
      securitiesRepository.find.mockResolvedValue([{ ...mockSecurity }]);
      securitiesRepository.manager.query.mockResolvedValue([]);

      const [quote] = await service.getFavouriteSecurities("user-1");

      expect(quote.currentPrice).toBeNull();
      expect(quote.dailyChange).toBe(0);
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

      const result = await service.deactivate("user-1", "sec-1");

      expect(result.isActive).toBe(false);
      expect(securitiesRepository.save).toHaveBeenCalled();
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

      const result = await service.deactivate("user-1", "sec-1");

      expect(result.isActive).toBe(false);
      expect(securitiesRepository.save).toHaveBeenCalled();
    });
  });

  describe("activate", () => {
    it("sets isActive to true", async () => {
      securitiesRepository.findOne.mockResolvedValue({
        ...mockSecurity,
        isActive: false,
      });

      const result = await service.activate("user-1", "sec-1");

      expect(result.isActive).toBe(true);
      expect(securitiesRepository.save).toHaveBeenCalled();
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
        mockDataSource.createQueryRunner(),
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
    it("returns the Yahoo profile description", async () => {
      mockYahooFinanceService.fetchSecurityProfileDescription.mockResolvedValue(
        "Apple Inc. designs phones.",
      );

      const result = await service.getSuggestedDescription("AAPL", "NASDAQ");

      expect(
        mockYahooFinanceService.fetchSecurityProfileDescription,
      ).toHaveBeenCalledWith("AAPL", "NASDAQ");
      expect(result).toEqual({
        symbol: "AAPL",
        description: "Apple Inc. designs phones.",
      });
    });

    it("returns a null description when Yahoo has nothing", async () => {
      mockYahooFinanceService.fetchSecurityProfileDescription.mockResolvedValue(
        null,
      );

      const result = await service.getSuggestedDescription("XYZ");

      expect(result).toEqual({ symbol: "XYZ", description: null });
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
});
