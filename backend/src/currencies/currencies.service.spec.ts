import { Test, TestingModule } from "@nestjs/testing";
import { DataSource, Repository } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  ConflictException,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { CurrenciesService } from "./currencies.service";
import { Currency } from "./entities/currency.entity";
import { UserCurrencyPreference } from "./entities/user-currency-preference.entity";
import { FxProviderChain } from "./providers/fx-provider-chain";
import { ExchangeRateHistoryService } from "./exchange-rate-history.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("CurrenciesService", () => {
  let service: CurrenciesService;
  let mockCurrencyRepo: Partial<Record<keyof Repository<Currency>, jest.Mock>>;
  let mockPrefRepo: Partial<
    Record<keyof Repository<UserCurrencyPreference>, jest.Mock>
  >;
  let mockDataSource: { query: jest.Mock };
  let chain: jest.Mocked<
    Pick<FxProviderChain, "carriesAny" | "verifyCurrency" | "searchCurrency">
  >;

  let rateHistory: jest.Mocked<
    Pick<ExchangeRateHistoryService, "forgetEmptyWindowsFor">
  >;

  const userId = "user-1";

  const mockCurrency: Currency = {
    code: "CAD",
    name: "Canadian Dollar",
    symbol: "CA$",
    decimalPlaces: 2,
    isActive: true,
    createdByUserId: null,
    createdAt: new Date(),

    kind: "FIAT",
    quoteSymbol: null,
  };

  beforeEach(async () => {
    mockCurrencyRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    mockPrefRepo = {
      findOne: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    };

    // Raw SQL now runs on the scoped transaction's EntityManager, so point the
    // spec's `mockDataSource.query` at the manager's jest.fn -- the assertions
    // below keep watching the same statements they always did.
    const scoped = createScopedDbMocks([
      [Currency, mockCurrencyRepo as Record<string, jest.Mock>],
      [UserCurrencyPreference, mockPrefRepo as Record<string, jest.Mock>],
    ]);
    scoped.dataSource.query = scoped.manager.query;
    mockDataSource = scoped.dataSource as unknown as { query: jest.Mock };

    rateHistory = { forgetEmptyWindowsFor: jest.fn() };

    chain = {
      carriesAny: jest.fn().mockResolvedValue(true),
      verifyCurrency: jest.fn().mockResolvedValue(null),
      searchCurrency: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrenciesService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        { provide: FxProviderChain, useValue: chain },
        { provide: ExchangeRateHistoryService, useValue: rateHistory },
      ],
    }).compile();

    service = module.get<CurrenciesService>(CurrenciesService);
  });

  describe("create()", () => {
    it("creates a new currency and preference row", async () => {
      const dto = {
        code: "NZD",
        name: "New Zealand Dollar",
        symbol: "NZ$",
        decimalPlaces: 2,
      };

      mockCurrencyRepo.findOne!.mockResolvedValue(null);
      mockCurrencyRepo.create!.mockReturnValue({
        ...dto,
        isActive: true,
        createdByUserId: userId,
        createdAt: new Date(),
      });
      mockCurrencyRepo.save!.mockResolvedValue({
        ...dto,
        isActive: true,
        createdByUserId: userId,
        createdAt: new Date(),
      });
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.create(userId, dto);

      expect(result.code).toBe("NZD");
      expect(result.isActive).toBe(true);
      expect(result.isSystem).toBe(false);
      expect(mockCurrencyRepo.findOne).toHaveBeenCalledWith({
        where: { code: "NZD" },
      });
    });

    it("throws ConflictException if user already has this currency", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockPrefRepo.findOne!.mockResolvedValue({
        userId,
        currencyCode: "CAD",
        isActive: true,
      });

      await expect(
        service.create(userId, { code: "CAD", name: "Test", symbol: "$" }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws a CURRENCY_INACTIVE conflict when the currency is present but inactive", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockPrefRepo.findOne!.mockResolvedValue({
        userId,
        currencyCode: "CAD",
        isActive: false,
      });

      expect.assertions(3);
      try {
        await service.create(userId, {
          code: "CAD",
          name: "Test",
          symbol: "$",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const response = (err as ConflictException).getResponse() as Record<
          string,
          unknown
        >;
        expect(response.errorCode).toBe("CURRENCY_INACTIVE");
        expect(response.currencyCode).toBe("CAD");
      }
    });

    it("adds preference row if currency exists but user doesn't have it", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockPrefRepo.findOne!.mockResolvedValue(null);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.create(userId, {
        code: "CAD",
        name: "Test",
        symbol: "$",
      });

      expect(result.code).toBe("CAD");
      expect(result.isSystem).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "CAD"],
      );
    });

    it("refuses with 409 a stated kind that differs from the existing row's, writing nothing", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue({
        ...mockCurrency,
        code: "BTC",
        kind: "FIAT",
      });
      mockPrefRepo.findOne!.mockResolvedValue(null);

      await expect(
        service.create(userId, {
          code: "BTC",
          name: "Bitcoin",
          symbol: "B",
          kind: "CRYPTO",
          quoteSymbol: "BTC-USD",
        }),
      ).rejects.toThrow(
        new ConflictException(
          'Currency "BTC" already exists as a FIAT currency and cannot be added as CRYPTO',
        ),
      );
      expect(mockDataSource.query).not.toHaveBeenCalled();
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("adopts an existing row when the stated kind matches it", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue({
        ...mockCurrency,
        code: "BTC",
        kind: "CRYPTO",
        quoteSymbol: "BTC-USD",
      });
      mockPrefRepo.findOne!.mockResolvedValue(null);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.create(userId, {
        code: "BTC",
        name: "Bitcoin",
        symbol: "B",
        kind: "CRYPTO",
      });

      expect(result.code).toBe("BTC");
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "BTC"],
      );
    });

    it("adopts an existing row of either kind when the request states no kind", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue({
        ...mockCurrency,
        code: "BTC",
        kind: "CRYPTO",
        quoteSymbol: "BTC-USD",
      });
      mockPrefRepo.findOne!.mockResolvedValue(null);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.create(userId, {
        code: "BTC",
        name: "Bitcoin",
        symbol: "B",
      });

      expect(result.code).toBe("BTC");
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "BTC"],
      );
    });

    it("adds preference row when currency was created by another user", async () => {
      const otherUserCurrency = {
        ...mockCurrency,
        code: "XYZ",
        createdByUserId: "other-user",
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(otherUserCurrency);
      mockPrefRepo.findOne!.mockResolvedValue(null);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.create(userId, {
        code: "XYZ",
        name: "Test",
        symbol: "X",
      });

      expect(result.code).toBe("XYZ");
      expect(result.isSystem).toBe(false);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "XYZ"],
      );
    });

    it("uppercases the code", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);
      mockCurrencyRepo.create!.mockReturnValue({
        code: "NZD",
        name: "Test",
        symbol: "$",
        isActive: true,
        createdByUserId: userId,
        createdAt: new Date(),
      });
      mockCurrencyRepo.save!.mockResolvedValue({
        code: "NZD",
        name: "Test",
        symbol: "$",
        isActive: true,
        createdByUserId: userId,
        createdAt: new Date(),
      });
      mockDataSource.query.mockResolvedValue([]);

      await service.create(userId, { code: "nzd", name: "Test", symbol: "$" });

      expect(mockCurrencyRepo.findOne).toHaveBeenCalledWith({
        where: { code: "NZD" },
      });
    });
  });

  describe("findAll()", () => {
    it("queries with user-scoped SQL", async () => {
      mockDataSource.query.mockResolvedValue([
        {
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
          isActive: true,
          isSystem: true,
          createdAt: new Date(),
        },
      ]);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("user_currency_preferences"),
        [userId],
      );
    });

    it("includes inactive currencies when requested", async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.findAll(userId, true);

      const query = mockDataSource.query.mock.calls[0][0];
      // When includeInactive=true, the WHERE clause should NOT filter by is_active
      expect(query).not.toContain("AND COALESCE(ucp.is_active");
    });

    it("filters inactive currencies by default", async () => {
      mockDataSource.query.mockResolvedValue([]);

      await service.findAll(userId);

      const query = mockDataSource.query.mock.calls[0][0];
      expect(query).toContain("AND COALESCE(ucp.is_active");
    });

    it("returns currencies with isSystem flag based on created_by_user_id", async () => {
      mockDataSource.query.mockResolvedValue([
        {
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
          isActive: true,
          isSystem: true,
          createdAt: new Date(),
        },
        {
          code: "XYZ",
          name: "Custom Currency",
          symbol: "X",
          decimalPlaces: 2,
          isActive: true,
          isSystem: false,
          createdAt: new Date(),
        },
      ]);

      const result = await service.findAll(userId, true);

      expect(result).toHaveLength(2);
      expect(result[0].isSystem).toBe(true);
      expect(result[1].isSystem).toBe(false);
    });

    it("returns empty array when user has no visible currencies and no default", async () => {
      // Main query empty, and the preferences lookup yields no default currency.
      mockDataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ default_currency: null }]);

      const result = await service.findAll(userId);

      expect(result).toEqual([]);
    });

    it("lazily creates the default-preference currency (with a real symbol) when the list is empty", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null); // missing during ensure
      mockDataSource.query
        .mockResolvedValueOnce([]) // main query: empty
        .mockResolvedValueOnce([{ default_currency: "EUR" }]) // preference lookup
        .mockResolvedValueOnce([]) // INSERT currencies
        .mockResolvedValueOnce([]) // INSERT user_currency_preferences
        .mockResolvedValueOnce([
          {
            code: "EUR",
            name: "Euro",
            symbol: "€",
            decimalPlaces: 2,
            isActive: true,
            isSystem: true,
            createdAt: new Date(),
          },
        ]); // re-query

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      expect(result[0].code).toBe("EUR");
      // The INSERT (3rd query) sets the proper symbol, not the bare code.
      const insertCall = mockDataSource.query.mock.calls[2];
      expect(insertCall[0]).toContain("INSERT INTO currencies");
      expect(insertCall[1]).toEqual([
        "EUR",
        "Euro",
        "€",
        2,
        false,
        null,
        "FIAT",
      ]);
      // ...and is activated for this user only (4th query).
      expect(mockDataSource.query.mock.calls[3][1]).toEqual([userId, "EUR"]);
    });
  });

  describe("getCatalog()", () => {
    it("returns the known currency catalog with real symbols", () => {
      const catalog = service.getCatalog();
      const usd = catalog.find((c) => c.code === "USD");
      expect(usd).toEqual({
        code: "USD",
        name: "US Dollar",
        symbol: "$",
        decimalPlaces: 2,
        kind: "FIAT",
      });
      // Nothing in the catalog is a coin: the kind is never inferred.
      expect(catalog.every((c) => c.kind === "FIAT")).toBe(true);
      // Sorted by code.
      expect(catalog[0].code.localeCompare(catalog[1].code)).toBeLessThan(0);
    });
  });

  describe("onApplicationBootstrap()", () => {
    it("ensures the default USD currency exists on startup", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await service.onApplicationBootstrap();

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO currencies"),
        ["USD", "US Dollar", "$", 2, "FIAT"],
      );
    });

    it("does not throw when the startup ensure fails", async () => {
      mockCurrencyRepo.findOne!.mockRejectedValue(new Error("db down"));

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe("ensureCurrencyForUser()", () => {
    const insertCall = () =>
      mockDataSource.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO currencies"),
      );
    const preferenceCall = () =>
      mockDataSource.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO user_currency_preferences"),
      );

    it("adds a known ISO code as an inactive system row and activates it for the user only", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await service.ensureCurrencyForUser(userId, "pln");

      expect(insertCall()![0]).toContain("ON CONFLICT (code) DO NOTHING");
      expect(insertCall()![1]).toEqual([
        "PLN",
        "Polish Zloty",
        "zł",
        2,
        false,
        null,
        "FIAT",
      ]);
      expect(preferenceCall()![0]).toContain(
        "ON CONFLICT (user_id, currency_code) DO UPDATE SET is_active = true",
      );
      expect(preferenceCall()![1]).toEqual([userId, "PLN"]);
    });

    it("adds a code outside ISO 4217 as the user's own active currency", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await service.ensureCurrencyForUser(userId, "ZZZ");

      const params = insertCall()![1];
      expect(params[0]).toBe("ZZZ");
      expect(params[4]).toBe(true);
      expect(params[5]).toBe(userId);
      expect(preferenceCall()![1]).toEqual([userId, "ZZZ"]);
    });

    it("never infers a coin: a code outside ISO 4217 is created FIAT", async () => {
      // `BTC` is not ISO 4217 and is the code a reader would pick for a coin;
      // the kind is still the reader's statement on the Currencies page.
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await service.ensureCurrencyForUser(userId, "btc");

      const [sql, params] = insertCall()!;
      expect(sql).toMatch(/created_by_user_id, kind\)/);
      expect(params[0]).toBe("BTC");
      expect(params[6]).toBe("FIAT");
    });

    it("leaves an existing row alone and still activates it for the user", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);

      await service.ensureCurrencyForUser(userId, "CAD");

      expect(insertCall()).toBeUndefined();
      expect(preferenceCall()![1]).toEqual([userId, "CAD"]);
    });

    it.each(["q#!", "US", "USDD", "", "U5D"])(
      "refuses %p before any write",
      async (code) => {
        await expect(
          service.ensureCurrencyForUser(userId, code),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(mockDataSource.query).not.toHaveBeenCalled();
      },
    );
  });

  describe("lockCurrenciesCreatedBy()", () => {
    it("locks the user's currencies in code order and returns their codes", async () => {
      const manager = { query: jest.fn().mockResolvedValue([{ code: "PTS" }]) };

      const codes = await service.lockCurrenciesCreatedBy(
        manager as never,
        userId,
      );

      expect(codes).toEqual(["PTS"]);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringMatching(
          /WHERE created_by_user_id = \$1 ORDER BY code FOR UPDATE/,
        ),
        [userId],
      );
    });
  });

  describe("removeUnreferencedCurrencies()", () => {
    it("deletes only the creatorless rows nothing references", async () => {
      const manager = {
        query: jest.fn((sql: string, params: string[]) => {
          if (sql.includes("currency_code_in_use_globally")) {
            return Promise.resolve([{ inUse: params[0] === "KEP" }]);
          }
          return Promise.resolve([]);
        }),
      };

      await service.removeUnreferencedCurrencies(manager as never, [
        "KEP",
        "PTS",
      ]);

      const deletes = manager.query.mock.calls.filter(([sql]) =>
        sql.includes("DELETE FROM currencies"),
      );
      expect(deletes).toHaveLength(1);
      expect(deletes[0][0]).toContain("created_by_user_id IS NULL");
      expect(deletes[0][1]).toEqual(["PTS"]);
    });

    it("does nothing for an empty list", async () => {
      const manager = { query: jest.fn() };

      await service.removeUnreferencedCurrencies(manager as never, []);

      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  describe("ensureCatalogCurrency()", () => {
    it("creates a missing currency inactive, so no user is offered it", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await service.ensureCatalogCurrency("pln");

      const [sql, params] = mockDataSource.query.mock.calls[0];
      expect(sql).toMatch(/VALUES \(\$1, \$2, \$3, \$4, false, NULL, \$5\)/);
      expect(params[4]).toBe("FIAT");
      expect(params[0]).toBe("PLN");
    });

    it("leaves an existing currency alone, active or not", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);

      await service.ensureCatalogCurrency("CAD");

      expect(mockDataSource.query).not.toHaveBeenCalled();
    });
  });

  describe("findOne()", () => {
    it("returns a currency by code", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);

      const result = await service.findOne("CAD");

      expect(result).toEqual(mockCurrency);
    });

    it("throws NotFoundException if currency not found", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await expect(service.findOne("XYZ")).rejects.toThrow(NotFoundException);
    });
  });

  describe("update()", () => {
    it("updates a user-created currency", async () => {
      const userCurrency = {
        ...mockCurrency,
        code: "NZD",
        createdByUserId: userId,
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      mockCurrencyRepo.save!.mockResolvedValue({
        ...userCurrency,
        name: "Updated Name",
      });
      mockPrefRepo.findOne!.mockResolvedValue({
        userId,
        currencyCode: "NZD",
        isActive: true,
      });

      const result = await service.update(userId, "NZD", {
        name: "Updated Name",
      });

      expect(result.name).toBe("Updated Name");
      expect(mockCurrencyRepo.save).toHaveBeenCalled();
    });

    it("throws ForbiddenException for system currencies", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);

      await expect(
        service.update(userId, "CAD", { name: "Updated" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException for another user's currency", async () => {
      const otherUserCurrency = {
        ...mockCurrency,
        createdByUserId: "other-user",
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(otherUserCurrency);

      await expect(
        service.update(userId, "CAD", { name: "Updated" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("handles isActive update via preference upsert", async () => {
      const userCurrency = {
        ...mockCurrency,
        code: "NZD",
        createdByUserId: userId,
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      mockCurrencyRepo.save!.mockResolvedValue(userCurrency);
      mockDataSource.query.mockResolvedValue([]);
      mockPrefRepo.findOne!.mockResolvedValue({
        userId,
        currencyCode: "NZD",
        isActive: false,
      });

      const result = await service.update(userId, "NZD", { isActive: false });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "NZD", false],
      );
      expect(result.isActive).toBe(false);
    });

    it("throws NotFoundException for non-existent currency", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await expect(
        service.update(userId, "XYZ", { name: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    describe("decimalPlaces", () => {
      const coin = {
        ...mockCurrency,
        code: "XBT",
        createdByUserId: userId,
        decimalPlaces: 8,
      };

      /** Answers the lock with the stored places and the function with `fitting`. */
      function stored(fitting: number): void {
        mockDataSource.query.mockImplementation(async (sql: string) =>
          sql.includes("FOR UPDATE")
            ? [{ decimal_places: 8 }]
            : sql.includes("currency_min_decimal_places_in_use")
              ? [{ fitting }]
              : [],
        );
      }
      const scans = () =>
        mockDataSource.query.mock.calls.filter(([sql]) =>
          String(sql).includes("currency_min_decimal_places_in_use"),
        );

      beforeEach(() => {
        mockCurrencyRepo.findOne!.mockResolvedValue({ ...coin });
        mockCurrencyRepo.save!.mockImplementation(async (row) => row);
        mockPrefRepo.findOne!.mockResolvedValue({
          userId,
          currencyCode: "XBT",
          isActive: true,
        });
      });

      it("refuses lowering 8 to 4 when a row carries 0.00002500, naming the places that fit", async () => {
        stored(6);

        const attempt = service.update(userId, "XBT", { decimalPlaces: 4 });

        await expect(attempt).rejects.toThrow(ConflictException);
        await expect(attempt).rejects.toThrow(/below 6 /);
        expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
        expect(scans()).toHaveLength(1);
        expect(scans()[0][1]).toEqual(["XBT"]);
      });

      it("asks the database-wide function once, not a scan under the caller's row-level security", async () => {
        stored(0);
        await service.update(userId, "XBT", { decimalPlaces: 4 });

        const sqls = mockDataSource.query.mock.calls.map(([sql]) =>
          String(sql),
        );
        // The lock, then one function call; no table of amounts is read here,
        // so another user's rows cannot be left out of the answer.
        expect(sqls.filter((sql) => sql.includes("FOR UPDATE"))).toHaveLength(
          1,
        );
        expect(scans()).toHaveLength(1);
        for (const table of [
          "FROM transactions",
          "FROM transaction_splits",
          "FROM scheduled_transactions",
          "FROM accounts",
        ]) {
          expect(sqls.some((sql) => sql.includes(table))).toBe(false);
        }
      });

      it("accepts lowering when every stored amount fits", async () => {
        stored(4);

        const view = await service.update(userId, "XBT", { decimalPlaces: 4 });

        expect(view.decimalPlaces).toBe(4);
        expect(mockCurrencyRepo.save).toHaveBeenCalled();
      });

      it("compares against the precision the amounts are held at, not the requested places", async () => {
        // moneyDecimalsFor(2) is 4: rows carrying 3 or 4 places fit a request for 2.
        stored(3);
        const view = await service.update(userId, "XBT", { decimalPlaces: 2 });

        expect(view.decimalPlaces).toBe(2);
        expect(mockCurrencyRepo.save).toHaveBeenCalled();
      });

      it("accepts raising without touching the data", async () => {
        mockCurrencyRepo.findOne!.mockResolvedValue({
          ...coin,
          decimalPlaces: 2,
        });
        stored(8);

        const view = await service.update(userId, "XBT", { decimalPlaces: 8 });

        expect(view.decimalPlaces).toBe(8);
        expect(scans()).toHaveLength(0);
      });

      it("reads the current value under the row lock, so a concurrent drop is not missed", async () => {
        // Read as 3 before the lock; another update raised it to 8 meanwhile.
        mockCurrencyRepo.findOne!.mockResolvedValue({
          ...coin,
          decimalPlaces: 3,
        });
        stored(8);

        await expect(
          service.update(userId, "XBT", { decimalPlaces: 2 }),
        ).rejects.toThrow(ConflictException);
      });
    });
  });

  describe("deactivate()", () => {
    it("upserts preference with isActive=false", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.deactivate(userId, "CAD");

      expect(result.isActive).toBe(false);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "CAD", false],
      );
    });
  });

  describe("activate()", () => {
    it("upserts preference with isActive=true", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue({
        ...mockCurrency,
        isActive: false,
      });
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.activate(userId, "CAD");

      expect(result.isActive).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO user_currency_preferences"),
        [userId, "CAD", true],
      );
    });

    it("returns correct UserCurrencyView shape", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.activate(userId, "CAD");

      expect(result).toEqual(
        expect.objectContaining({
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
          isActive: true,
          isSystem: true,
        }),
      );
    });

    it("throws NotFoundException for non-existent currency", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await expect(service.activate(userId, "XYZ")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("deactivate() edge cases", () => {
    it("returns correct UserCurrencyView shape", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.deactivate(userId, "CAD");

      expect(result).toEqual(
        expect.objectContaining({
          code: "CAD",
          name: "Canadian Dollar",
          isActive: false,
          isSystem: true,
        }),
      );
    });

    it("throws NotFoundException for non-existent currency", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);

      await expect(service.deactivate(userId, "XYZ")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("remove()", () => {
    /**
     * Route by the SQL, not by call order.
     *
     * These tests used positional `mockResolvedValueOnce` chains, so adding the
     * `FOR UPDATE` lock -- a query that returns nothing and is asserted for its
     * side effect -- broke three of them for a reason that had nothing to do with
     * what they were testing. A fixture that has to be renumbered whenever a
     * statement is inserted is measuring the sequence rather than the behaviour.
     */
    const answering = (opts: {
      inUseByUser?: boolean;
      inUseGlobally?: boolean;
    }) => {
      mockDataSource.query.mockImplementation(async (sql: string) => {
        if (/FOR UPDATE/i.test(sql)) return [];
        if (sql.includes("currency_codes_referenced_by_user_data")) {
          return [{ inUse: opts.inUseByUser ?? false }];
        }
        if (sql.includes("currency_code_in_use_globally")) {
          return [{ inUse: opts.inUseGlobally ?? false }];
        }
        return [];
      });
    };

    it("removes preference row for a currency not in use", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      expect(mockPrefRepo.delete).toHaveBeenCalledWith({
        userId,
        currencyCode: "CAD",
      });
    });

    it("throws ConflictException if currency is in use by user", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: true }]);

      await expect(service.remove(userId, "CAD")).rejects.toThrow(
        ConflictException,
      );
    });

    it("deletes non-system currency if no other users reference it", async () => {
      const userCurrency = {
        ...mockCurrency,
        createdByUserId: userId,
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      answering({ inUseByUser: false, inUseGlobally: false });
      mockPrefRepo.delete!.mockResolvedValue(undefined);
      mockPrefRepo.count!.mockResolvedValue(0);
      mockCurrencyRepo.remove!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      expect(mockCurrencyRepo.remove).toHaveBeenCalledWith(userCurrency);
    });

    /**
     * INV-CURRENCY-001, authorization clause: a shared custom currency row is
     * deleted only by its creator. A non-creator who activated the code may
     * deactivate it (remove their own preference), but must never take the row
     * itself -- even when the global count has since hit zero. The old gate
     * (`createdByUserId !== null`) checked "is this custom" instead of "am I the
     * creator", so this exact call deleted another user's currency.
     */
    it("does not delete another user's custom currency, even when globally unreferenced", async () => {
      const othersCurrency = {
        ...mockCurrency,
        createdByUserId: "other-user",
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(othersCurrency);
      answering({ inUseByUser: false, inUseGlobally: false });
      mockPrefRepo.delete!.mockResolvedValue(undefined);
      mockCurrencyRepo.remove!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      // Deactivation still happens...
      expect(mockPrefRepo.delete).toHaveBeenCalledWith({
        userId,
        currencyCode: "CAD",
      });
      // ...but the creator's row is left standing.
      expect(mockCurrencyRepo.remove).not.toHaveBeenCalled();
    });

    it("does not delete system currency row even when preference is removed", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      expect(mockPrefRepo.delete).toHaveBeenCalledWith({
        userId,
        currencyCode: "CAD",
      });
      expect(mockCurrencyRepo.remove).not.toHaveBeenCalled();
    });

    it("keeps non-system currency if other users still reference it", async () => {
      const userCurrency = {
        ...mockCurrency,
        createdByUserId: userId,
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      // isInUse (this user) says no; the global check says yes -- which is the
      // only combination that can happen when another user activated the code,
      // because everything this user owns was already ruled out.
      answering({ inUseByUser: false, inUseGlobally: true });
      mockPrefRepo.delete!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      expect(mockPrefRepo.delete).toHaveBeenCalled();
      expect(mockCurrencyRepo.remove).not.toHaveBeenCalled();
    });

    /**
     * The liveness decision must not be re-derived here. It used to be, twice
     * over: a `user_currency_preferences` count that RLS filtered to this user's
     * own row (so it always returned zero, whoever else had activated the code)
     * followed by a hand-written reference query missing three columns. The
     * cascade on `user_currency_preferences.currency_code` then deleted the other
     * user's activation.
     */
    it("asks the database for a genuinely global answer", async () => {
      const userCurrency = { ...mockCurrency, createdByUserId: userId };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      const globalCheck = mockDataSource.query.mock.calls.find(
        ([sql]) =>
          typeof sql === "string" &&
          sql.includes("currency_code_in_use_globally"),
      );
      expect(globalCheck).toBeDefined();
      expect(globalCheck![1]).toEqual(["CAD"]);
      // A tenant-scoped count cannot see another user's preference row, so it
      // must not be what the decision rests on.
      expect(mockPrefRepo.count).not.toHaveBeenCalled();
    });

    it("keeps non-system currency if globally in use despite no preferences", async () => {
      const userCurrency = {
        ...mockCurrency,
        createdByUserId: userId,
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      answering({ inUseByUser: false, inUseGlobally: true });
      mockPrefRepo.delete!.mockResolvedValue(undefined);
      mockPrefRepo.count!.mockResolvedValue(0);

      await service.remove(userId, "CAD");

      expect(mockCurrencyRepo.remove).not.toHaveBeenCalled();
    });

    /**
     * The lock is the whole of F3R-005. Without it the transaction boundary is
     * not enough: an activation is an INSERT into `user_currency_preferences`
     * whose FK to `currencies(code)` cascades on delete, so another user could
     * commit a preference between the global liveness check and the DELETE and
     * have it removed by the cascade -- after being told it was saved.
     *
     * `FOR UPDATE` conflicts with the `FOR KEY SHARE` an FK check takes on the
     * parent, so the concurrent insert waits and then fails cleanly. Only a
     * two-connection integration test can show that; what this asserts is the
     * ordering the lock has to have, which is what a later refactor would break.
     */
    it("locks the currency row before any liveness-dependent step", async () => {
      const userCurrency = { ...mockCurrency, createdByUserId: userId };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);

      const order: string[] = [];
      mockDataSource.query.mockImplementation(async (sql: string) => {
        if (/FOR UPDATE/i.test(sql)) {
          order.push("lock");
          return [];
        }
        if (sql.includes("currency_codes_referenced_by_user_data")) {
          order.push("isInUse");
          return [{ inUse: false }];
        }
        if (sql.includes("currency_code_in_use_globally")) {
          order.push("globalCheck");
          return [{ inUse: false }];
        }
        return [];
      });
      mockPrefRepo.delete!.mockImplementation(async () => {
        order.push("deletePreference");
        return undefined;
      });
      mockCurrencyRepo.remove!.mockImplementation(async () => {
        order.push("deleteCurrency");
        return undefined;
      });

      await service.remove(userId, "CAD");

      expect(order).toEqual([
        "lock",
        "isInUse",
        "deletePreference",
        "globalCheck",
        "deleteCurrency",
      ]);
      // Specifically: nothing that depends on liveness happens before the lock.
      expect(order.indexOf("lock")).toBe(0);
    });

    it("uppercases code before processing", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);

      await service.remove(userId, "cad");

      expect(mockCurrencyRepo.findOne).toHaveBeenCalledWith({
        where: { code: "CAD" },
      });
    });
  });

  describe("getUsage()", () => {
    it("returns user-scoped usage counts per currency", async () => {
      mockDataSource.query.mockResolvedValue([
        { code: "CAD", accounts: "3", securities: "5" },
        { code: "USD", accounts: "1", securities: "0" },
      ]);

      const result = await service.getUsage(userId);

      expect(result).toEqual({
        CAD: { accounts: 3, securities: 5 },
        USD: { accounts: 1, securities: 0 },
      });
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("user_id = $1"),
        [userId],
      );
    });
  });

  describe("isInUse()", () => {
    it("checks user-scoped usage", async () => {
      mockDataSource.query.mockResolvedValue([{ inUse: true }]);

      const result = await service.isInUse(userId, "CAD");

      expect(result).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT EXISTS"),
        ["CAD", userId],
      );
    });

    it("returns false when currency is not in use by user", async () => {
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);

      const result = await service.isInUse(userId, "XYZ");

      expect(result).toBe(false);
    });

    it("uppercases the code before querying", async () => {
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);

      await service.isInUse(userId, "cad");

      expect(mockDataSource.query).toHaveBeenCalledWith(expect.any(String), [
        "CAD",
        userId,
      ]);
    });

    it("returns false when query returns unexpected shape", async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.isInUse(userId, "CAD");

      expect(result).toBe(false);
    });
  });

  describe("lookupCurrency()", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      // Every provider question goes through the chain (INV-FX-005); a bare
      // call from the service would land here and fail the assertions below.
      global.fetch = jest.fn();
    });

    afterEach(() => {
      expect(global.fetch).not.toHaveBeenCalled();
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("returns null for queries shorter than 2 characters", async () => {
      const result = await service.lookupCurrency("A");

      expect(result).toBeNull();
      expect(chain.carriesAny).not.toHaveBeenCalled();
      expect(chain.searchCurrency).not.toHaveBeenCalled();
    });

    it("returns null for empty string", async () => {
      const result = await service.lookupCurrency("");

      expect(result).toBeNull();
    });

    it("returns null for single whitespace-padded character", async () => {
      const result = await service.lookupCurrency("  A  ");

      expect(result).toBeNull();
    });

    describe("direct code match", () => {
      it("matches a known currency code directly (e.g., CAD)", async () => {
        const result = await service.lookupCurrency("CAD");

        expect(result).toEqual({
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
        });
      });

      it("matches a known currency code case-insensitively", async () => {
        const result = await service.lookupCurrency("jpy");

        expect(result).toEqual({
          code: "JPY",
          name: "Japanese Yen",
          symbol: "\u00A5",
          decimalPlaces: 0,
        });
      });

      it("a code a configured provider carries is verified without asking any provider to verify it", async () => {
        const result = await service.lookupCurrency("CHF");

        expect(chain.carriesAny).toHaveBeenCalledWith("CHF");
        expect(chain.verifyCurrency).not.toHaveBeenCalled();
        expect(chain.searchCurrency).not.toHaveBeenCalled();
        expect(result?.code).toBe("CHF");
      });

      it("a code no provider carries is put to the providers' verification", async () => {
        chain.carriesAny.mockResolvedValue(false);
        chain.verifyCurrency.mockResolvedValue(true);

        const result = await service.lookupCurrency("KWD");

        expect(chain.verifyCurrency).toHaveBeenCalledWith("KWD");
        expect(result).toEqual({
          code: "KWD",
          name: "Kuwaiti Dinar",
          symbol: "KWD",
          decimalPlaces: 3,
        });
      });

      it.each([
        ["no provider knows it", false],
        ["no provider answered", null],
      ])(
        "still returns local metadata when %s",
        async (_label, known: boolean | null) => {
          chain.carriesAny.mockResolvedValue(false);
          chain.verifyCurrency.mockResolvedValue(known);

          const result = await service.lookupCurrency("EUR");

          expect(result).toEqual({
            code: "EUR",
            name: "Euro",
            symbol: "\u20AC",
            decimalPlaces: 2,
          });
        },
      );

      it("still returns local metadata when a provider's verification throws", async () => {
        chain.carriesAny.mockResolvedValue(false);
        chain.verifyCurrency.mockRejectedValue(new Error("boom"));

        const result = await service.lookupCurrency("KWD");

        expect(chain.verifyCurrency).toHaveBeenCalledWith("KWD");
        expect(result).toEqual({
          code: "KWD",
          name: "Kuwaiti Dinar",
          symbol: "KWD",
          decimalPlaces: 3,
        });
      });

      it("still returns local metadata when verification throws", async () => {
        chain.carriesAny.mockRejectedValue(new Error("Network error"));

        const result = await service.lookupCurrency("GBP");

        expect(result).toEqual({
          code: "GBP",
          name: "British Pound",
          symbol: "\u00A3",
          decimalPlaces: 2,
        });
      });
    });

    describe("name/text match via searchMetadataByText", () => {
      it("matches an exact currency name (e.g., 'Canadian Dollar')", async () => {
        const result = await service.lookupCurrency("Canadian Dollar");

        expect(chain.carriesAny).toHaveBeenCalledWith("CAD");
        expect(result).toEqual({
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
        });
      });

      it("matches exact name case-insensitively", async () => {
        const result = await service.lookupCurrency("japanese yen");

        expect(result).toEqual({
          code: "JPY",
          name: "Japanese Yen",
          symbol: "\u00A5",
          decimalPlaces: 0,
        });
      });

      it("matches a substring uniquely (e.g., 'Ringgit' matches 'Malaysian Ringgit')", async () => {
        const result = await service.lookupCurrency("Ringgit");

        expect(result).toEqual({
          code: "MYR",
          name: "Malaysian Ringgit",
          symbol: "RM",
          decimalPlaces: 2,
        });
      });

      it("matches a unique substring like 'Baht' for Thai Baht", async () => {
        const result = await service.lookupCurrency("Baht");

        expect(result).toEqual({
          code: "THB",
          name: "Thai Baht",
          symbol: "\u0E3F",
          decimalPlaces: 2,
        });
      });

      it("falls through to the providers' search for an ambiguous substring (e.g., 'Dollar')", async () => {
        const result = await service.lookupCurrency("Dollar");

        expect(chain.searchCurrency).toHaveBeenCalledWith("Dollar");
        expect(result).toBeNull();
      });
    });

    describe("provider search fallback", () => {
      it("asks the chain's search with the trimmed query and returns the code's metadata", async () => {
        chain.searchCurrency.mockResolvedValue("MYR");

        const result = await service.lookupCurrency("  Ringgit Malaysia  ");

        expect(chain.searchCurrency).toHaveBeenCalledWith("Ringgit Malaysia");
        expect(result).toEqual({
          code: "MYR",
          name: "Malaysian Ringgit",
          symbol: "RM",
          decimalPlaces: 2,
        });
      });

      it("uses the code as name and symbol when it is not in CURRENCY_METADATA", async () => {
        chain.searchCurrency.mockResolvedValue("ABC");

        const result = await service.lookupCurrency("something exotic");

        expect(result).toEqual({
          code: "ABC",
          name: "ABC",
          symbol: "ABC",
          decimalPlaces: 2,
        });
      });

      it("returns null when no provider's search resolves the query", async () => {
        const result = await service.lookupCurrency("xyznonexistent");

        expect(result).toBeNull();
      });

      it("returns null when the search throws", async () => {
        chain.searchCurrency.mockRejectedValue(new Error("boom"));

        const result = await service.lookupCurrency("something unknown");

        expect(result).toBeNull();
      });
    });

    it("trims whitespace from query before processing", async () => {
      const result = await service.lookupCurrency("  CAD  ");

      expect(result).toEqual({
        code: "CAD",
        name: "Canadian Dollar",
        symbol: "CA$",
        decimalPlaces: 2,
      });
    });
  });

  /**
   * The currency-write rows of section 5 of `docs/specs/crypto-accounts.md`:
   * every refusal happens before anything is written.
   */
  describe("kind and price symbol", () => {
    const coin = (overrides: Partial<Currency> = {}): Currency => ({
      ...mockCurrency,
      code: "BTC",
      name: "Bitcoin",
      symbol: "B",
      decimalPlaces: 4,
      createdByUserId: userId,
      kind: "CRYPTO",
      quoteSymbol: "BTC-CAD",
      ...overrides,
    });

    /** `create` echoes what it was given, as the repository does. */
    function echoCreate(): void {
      mockCurrencyRepo.findOne!.mockResolvedValue(null);
      mockCurrencyRepo.create!.mockImplementation((row) => row);
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
    }

    /**
     * The database's two answers for the code: `data` from
     * `currency_code_referenced_by_data` (every reference but activations),
     * folded into `currency_code_in_use_globally` with the activation as the
     * real functions do.
     */
    function references(data: boolean, activation = true): void {
      mockDataSource.query.mockImplementation(async (sql: string) =>
        sql.includes("currency_code_referenced_by_data")
          ? [{ inUse: data }]
          : sql.includes("currency_code_in_use_globally")
            ? [{ inUse: data || activation }]
            : [],
      );
    }
    const referencedGlobally = (inUse: boolean) => references(inUse);

    const globalCheck = () =>
      mockDataSource.query.mock.calls.filter(([sql]) =>
        /currency_code_(referenced_by_data|in_use_globally)/.test(String(sql)),
      );

    it("creates a coin with its price symbol, and eight places by default", async () => {
      echoCreate();

      const view = await service.create(userId, {
        code: "BTC",
        name: "Bitcoin",
        symbol: "B",
        kind: "CRYPTO",
        quoteSymbol: "BTC-EUR",
      });

      expect(mockCurrencyRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "CRYPTO",
          quoteSymbol: "BTC-EUR",
          decimalPlaces: 8,
        }),
      );
      expect(view).toMatchObject({
        code: "BTC",
        kind: "CRYPTO",
        quoteSymbol: "BTC-EUR",
        decimalPlaces: 8,
      });
    });

    it("creates a coin without a price symbol: allowed, unpriced", async () => {
      echoCreate();

      const view = await service.create(userId, {
        code: "XYZ",
        name: "Some Coin",
        symbol: "X",
        kind: "CRYPTO",
      });

      expect(view).toMatchObject({ kind: "CRYPTO", quoteSymbol: null });
    });

    it("creates FIAT when no kind is given, even for a code like BTC, at two places", async () => {
      echoCreate();

      const view = await service.create(userId, {
        code: "BTC",
        name: "Not a coin",
        symbol: "B",
      });

      expect(view).toMatchObject({
        kind: "FIAT",
        quoteSymbol: null,
        decimalPlaces: 2,
      });
    });

    it.each([[{ kind: "FIAT" as const }], [{}]])(
      "refuses a price symbol on a fiat currency (%p) before any write",
      async (kindField) => {
        echoCreate();

        await expect(
          service.create(userId, {
            code: "XYZ",
            name: "X",
            symbol: "X",
            quoteSymbol: "BTC-EUR",
            ...kindField,
          }),
        ).rejects.toThrow(BadRequestException);
        await expect(
          service.create(userId, {
            code: "XYZ",
            name: "X",
            symbol: "X",
            quoteSymbol: "BTC-EUR",
            ...kindField,
          }),
        ).rejects.toThrow(/can only be set on a cryptocurrency/);
        expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
        expect(mockDataSource.query).not.toHaveBeenCalled();
      },
    );

    it("refuses a price symbol with no fiat leg before any write", async () => {
      echoCreate();

      await expect(
        service.create(userId, {
          code: "BTC",
          name: "Bitcoin",
          symbol: "B",
          kind: "CRYPTO",
          quoteSymbol: "BTC",
        }),
      ).rejects.toThrow(/is not a coin and fiat pair/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("lists each currency's kind and price symbol", async () => {
      mockDataSource.query.mockResolvedValue([
        { code: "BTC", kind: "CRYPTO", quoteSymbol: "BTC-CAD" },
      ]);

      const rows = await service.findAll(userId);

      const [sql] = mockDataSource.query.mock.calls[0];
      expect(sql).toContain("c.kind");
      expect(sql).toContain('c.quote_symbol AS "quoteSymbol"');
      expect(rows[0]).toMatchObject({ kind: "CRYPTO", quoteSymbol: "BTC-CAD" });
    });

    it("kind changes on a currency only the creator's preference references", async () => {
      // The creator's activation row is always there; it is a list entry, not
      // a use, so it must not freeze the kind.
      mockCurrencyRepo.findOne!.mockResolvedValue(
        coin({ code: "XYZ", kind: "FIAT", quoteSymbol: null }),
      );
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      references(false, true);

      const view = await service.update(userId, "XYZ", {
        kind: "CRYPTO",
        quoteSymbol: "XYZ-USD",
      });

      expect(view).toMatchObject({ kind: "CRYPTO", quoteSymbol: "XYZ-USD" });
      const asked = globalCheck().map(([sql]) => String(sql));
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("currency_code_referenced_by_data");
    });

    it("kind change refused once an account references it", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(
        coin({ code: "XYZ", kind: "FIAT", quoteSymbol: null }),
      );
      // An account in XYZ is data: `currency_code_referenced_by_data` is true.
      references(true, true);

      await expect(
        service.update(userId, "XYZ", { kind: "CRYPTO" }),
      ).rejects.toThrow(/cannot change while/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a kind change on a code any row anywhere references, before any write", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      referencedGlobally(true);

      await expect(
        service.update(userId, "BTC", { kind: "FIAT" }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.update(userId, "BTC", { kind: "FIAT" }),
      ).rejects.toThrow(/cannot change while/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
      // The row is locked before the global question is asked.
      const sqls = mockDataSource.query.mock.calls.map(([sql]) => String(sql));
      const lock = sqls.findIndex((sql) => sql.includes("FOR UPDATE"));
      const check = sqls.findIndex((sql) =>
        sql.includes("currency_code_referenced_by_data"),
      );
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(check);
    });

    it("changes the kind of an unreferenced code, dropping a price symbol a fiat row cannot hold", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      referencedGlobally(false);

      const view = await service.update(userId, "BTC", { kind: "FIAT" });

      expect(mockCurrencyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "FIAT", quoteSymbol: null }),
      );
      expect(view).toMatchObject({ kind: "FIAT", quoteSymbol: null });
    });

    it("refuses a price symbol named on a currency turning fiat", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      referencedGlobally(false);

      await expect(
        service.update(userId, "BTC", { kind: "FIAT", quoteSymbol: "BTC-EUR" }),
      ).rejects.toThrow(/can only be set on a cryptocurrency/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a price symbol on a fiat row when the update leaves the kind alone", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(
        coin({ code: "XYZ", kind: "FIAT", quoteSymbol: null }),
      );

      await expect(
        service.update(userId, "XYZ", { quoteSymbol: "BTC-EUR" }),
      ).rejects.toThrow(BadRequestException);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("reprices a referenced coin: a new symbol on an unchanged kind is not a kind change", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      referencedGlobally(true);

      const view = await service.update(userId, "BTC", {
        kind: "CRYPTO",
        quoteSymbol: "BTC-EUR",
      });

      expect(view.quoteSymbol).toBe("BTC-EUR");
      expect(globalCheck()).toHaveLength(0);
    });

    /**
     * `currencies` is shared: re-pointing a referenced coin at another coin's
     * ticker would revalue every other user's wallet at that coin's price, so
     * a ticker change is held like a kind change. The fiat leg alone stays
     * free (the provider prices against whichever fiat a pair names).
     */
    it("refuses a new coin ticker on a referenced coin, locking first and writing nothing", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      references(true);

      await expect(
        service.update(userId, "BTC", { quoteSymbol: "ETH-CAD" }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.update(userId, "BTC", { quoteSymbol: "ETH-CAD" }),
      ).rejects.toThrow(/The coin in the price symbol of "BTC" cannot change/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
      const sqls = mockDataSource.query.mock.calls.map(([sql]) => String(sql));
      const lock = sqls.findIndex((sql) => sql.includes("FOR UPDATE"));
      const check = sqls.findIndex((sql) =>
        sql.includes("currency_code_referenced_by_data"),
      );
      expect(lock).toBeGreaterThanOrEqual(0);
      expect(lock).toBeLessThan(check);
    });

    it("refuses removing the price symbol of a referenced coin, which changes its ticker to none", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      references(true);

      await expect(
        service.update(userId, "BTC", { quoteSymbol: null }),
      ).rejects.toThrow(/cannot change while/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("re-points the ticker of a coin nothing references", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      references(false);

      const view = await service.update(userId, "BTC", {
        quoteSymbol: "XBT-CAD",
      });

      expect(view.quoteSymbol).toBe("XBT-CAD");
      expect(globalCheck()).toHaveLength(1);
    });

    it("changes only the fiat leg of a referenced coin without asking about references", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      references(true);

      const view = await service.update(userId, "BTC", {
        quoteSymbol: "BTC-USD",
      });

      expect(view.quoteSymbol).toBe("BTC-USD");
      expect(globalCheck()).toHaveLength(0);
    });

    it("sets a first price symbol on a referenced coin that had none", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin({ quoteSymbol: null }));
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      references(true);

      const view = await service.update(userId, "BTC", {
        quoteSymbol: "BTC-EUR",
      });

      expect(view.quoteSymbol).toBe("BTC-EUR");
      expect(globalCheck()).toHaveLength(0);
    });

    /**
     * A fill for a coin without a symbol (or under its old ticker) recorded
     * where the provider's history starts, and the provider fingerprint those
     * rows are scoped to does not change with a symbol: left in place, every
     * past window of the newly mapped coin would be skipped.
     */
    describe("what a fill learned under the old price symbol", () => {
      const coverageDeletes = () =>
        mockDataSource.query.mock.calls.filter(([sql]) =>
          String(sql).includes("DELETE FROM exchange_rate_coverage"),
        );

      it("deletes the code's coverage in both code orders and forgets its empty windows when a first symbol is set", async () => {
        mockCurrencyRepo.findOne!.mockResolvedValue(
          coin({ code: "DOG", quoteSymbol: null }),
        );
        mockCurrencyRepo.save!.mockImplementation(async (row) => row);
        references(true);

        await service.update(userId, "DOG", { quoteSymbol: "DOGE-USD" });

        const deletes = coverageDeletes();
        expect(deletes).toHaveLength(1);
        expect(String(deletes[0][0])).toMatch(
          /WHERE from_currency = \$1 OR to_currency = \$1/,
        );
        expect(deletes[0][1]).toEqual(["DOG"]);
        // Inside the update's transaction, before the row is saved.
        const deleteOrder =
          mockDataSource.query.mock.invocationCallOrder[
            mockDataSource.query.mock.calls.indexOf(deletes[0])
          ];
        expect(deleteOrder).toBeLessThan(
          mockCurrencyRepo.save!.mock.invocationCallOrder[0],
        );
        expect(rateHistory.forgetEmptyWindowsFor).toHaveBeenCalledWith("DOG");
      });

      it("does the same when the coin ticker is re-pointed", async () => {
        mockCurrencyRepo.findOne!.mockResolvedValue(coin());
        mockCurrencyRepo.save!.mockImplementation(async (row) => row);
        references(false);

        await service.update(userId, "BTC", { quoteSymbol: "XBT-CAD" });

        expect(coverageDeletes()).toHaveLength(1);
        expect(rateHistory.forgetEmptyWindowsFor).toHaveBeenCalledWith("BTC");
      });

      it("keeps both when only the fiat leg changes or nothing does", async () => {
        mockCurrencyRepo.findOne!.mockResolvedValue(coin());
        mockCurrencyRepo.save!.mockImplementation(async (row) => row);
        references(true);

        await service.update(userId, "BTC", { quoteSymbol: "BTC-USD" });
        await service.update(userId, "BTC", { quoteSymbol: "BTC-CAD" });
        await service.update(userId, "BTC", { name: "Bitcoin!" });

        expect(coverageDeletes()).toHaveLength(0);
        expect(rateHistory.forgetEmptyWindowsFor).not.toHaveBeenCalled();
      });

      it("forgets nothing when the change is refused", async () => {
        mockCurrencyRepo.findOne!.mockResolvedValue(coin());
        references(true);

        await expect(
          service.update(userId, "BTC", { quoteSymbol: "ETH-CAD" }),
        ).rejects.toThrow(ConflictException);

        expect(coverageDeletes()).toHaveLength(0);
        expect(rateHistory.forgetEmptyWindowsFor).not.toHaveBeenCalled();
      });
    });

    it("refuses a repricing symbol with no fiat leg", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());

      await expect(
        service.update(userId, "BTC", { quoteSymbol: "BTC-USDT" }),
      ).rejects.toThrow(/is not a coin and fiat pair/);
      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
    });

    it("clears the price symbol of a coin nothing references with null", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      mockCurrencyRepo.save!.mockImplementation(async (row) => row);
      // Removing the symbol is a ticker change (to none), held like a kind
      // change; unreferenced, it is allowed.
      references(false);

      const view = await service.update(userId, "BTC", { quoteSymbol: null });

      expect(view).toMatchObject({ kind: "CRYPTO", quoteSymbol: null });
    });

    it("writes nothing when the form resends the same kind and symbol", async () => {
      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      referencedGlobally(true);

      await service.update(userId, "BTC", {
        kind: "CRYPTO",
        quoteSymbol: "BTC-CAD",
      });

      expect(mockCurrencyRepo.save).not.toHaveBeenCalled();
      expect(globalCheck()).toHaveLength(0);
    });

    it("tells the crypto exchange rate provider to re-read currencies after a write", async () => {
      const cryptoFx = { forgetCurrencies: jest.fn() };
      const withProvider = new CurrenciesService(
        mockDataSource as never,
        chain as never,
        cryptoFx as never,
      );
      echoCreate();

      await withProvider.create(userId, {
        code: "BTC",
        name: "Bitcoin",
        symbol: "B",
        kind: "CRYPTO",
      });
      expect(cryptoFx.forgetCurrencies).toHaveBeenCalledTimes(1);

      mockCurrencyRepo.findOne!.mockResolvedValue(coin());
      await withProvider.update(userId, "BTC", { name: "Bitcoin (cold)" });
      expect(cryptoFx.forgetCurrencies).toHaveBeenCalledTimes(2);

      mockCurrencyRepo.findOne!.mockResolvedValue(null);
      await withProvider.ensureCurrencyForUser(userId, "PLN");
      expect(cryptoFx.forgetCurrencies).toHaveBeenCalledTimes(3);
    });
  });
});
