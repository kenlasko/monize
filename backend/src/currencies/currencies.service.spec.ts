import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import {
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { CurrenciesService } from "./currencies.service";
import { Currency } from "./entities/currency.entity";
import { UserCurrencyPreference } from "./entities/user-currency-preference.entity";

describe("CurrenciesService", () => {
  let service: CurrenciesService;
  let mockCurrencyRepo: Partial<Record<keyof Repository<Currency>, jest.Mock>>;
  let mockPrefRepo: Partial<
    Record<keyof Repository<UserCurrencyPreference>, jest.Mock>
  >;
  let mockDataSource: { query: jest.Mock };

  const userId = "user-1";

  const mockCurrency: Currency = {
    code: "CAD",
    name: "Canadian Dollar",
    symbol: "CA$",
    decimalPlaces: 2,
    isActive: true,
    createdByUserId: null,
    createdAt: new Date(),
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

    mockDataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrenciesService,
        {
          provide: getRepositoryToken(Currency),
          useValue: mockCurrencyRepo,
        },
        {
          provide: getRepositoryToken(UserCurrencyPreference),
          useValue: mockPrefRepo,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
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

    it("returns empty array when user has no visible currencies", async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.findAll(userId);

      expect(result).toEqual([]);
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
      // First query: isInUse returns false
      // Second query: isInUseGlobally returns false
      mockDataSource.query
        .mockResolvedValueOnce([{ inUse: false }])
        .mockResolvedValueOnce([{ inUse: false }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);
      mockPrefRepo.count!.mockResolvedValue(0);
      mockCurrencyRepo.remove!.mockResolvedValue(undefined);

      await service.remove(userId, "CAD");

      expect(mockCurrencyRepo.remove).toHaveBeenCalledWith(userCurrency);
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
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);
      mockPrefRepo.count!.mockResolvedValue(2);

      await service.remove(userId, "CAD");

      expect(mockPrefRepo.delete).toHaveBeenCalled();
      expect(mockCurrencyRepo.remove).not.toHaveBeenCalled();
    });

    it("keeps non-system currency if globally in use despite no preferences", async () => {
      const userCurrency = {
        ...mockCurrency,
        createdByUserId: userId,
      };
      mockCurrencyRepo.findOne!.mockResolvedValue(userCurrency);
      // First query: isInUse returns false
      // Second query: isInUseGlobally returns true
      mockDataSource.query
        .mockResolvedValueOnce([{ inUse: false }])
        .mockResolvedValueOnce([{ inUse: true }]);
      mockPrefRepo.delete!.mockResolvedValue(undefined);
      mockPrefRepo.count!.mockResolvedValue(0);

      await service.remove(userId, "CAD");

      expect(mockCurrencyRepo.remove).not.toHaveBeenCalled();
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
      global.fetch = jest.fn();
    });

    afterAll(() => {
      global.fetch = originalFetch;
    });

    it("returns null for queries shorter than 2 characters", async () => {
      const result = await service.lookupCurrency("A");

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
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
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("CAD");

        expect(result).toEqual({
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
        });
      });

      it("matches a known currency code case-insensitively", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("jpy");

        expect(result).toEqual({
          code: "JPY",
          name: "Japanese Yen",
          symbol: "\u00A5",
          decimalPlaces: 0,
        });
      });

      it("still returns metadata when Yahoo verification fails with non-ok response", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: false,
          status: 404,
        });

        const result = await service.lookupCurrency("EUR");

        expect(result).toEqual({
          code: "EUR",
          name: "Euro",
          symbol: "\u20AC",
          decimalPlaces: 2,
        });
      });

      it("still returns metadata when Yahoo verification throws a network error", async () => {
        (global.fetch as jest.Mock).mockRejectedValue(
          new Error("Network error"),
        );

        const result = await service.lookupCurrency("GBP");

        expect(result).toEqual({
          code: "GBP",
          name: "British Pound",
          symbol: "\u00A3",
          decimalPlaces: 2,
        });
      });

      it("calls Yahoo chart API with correct URL for verification", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        await service.lookupCurrency("CHF");

        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining("CHFUSD%3DX"),
          expect.objectContaining({
            headers: expect.objectContaining({
              "User-Agent": expect.any(String),
            }),
          }),
        );
      });

      it("preserves decimalPlaces=3 for currencies like Kuwaiti Dinar", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("KWD");

        expect(result).toEqual({
          code: "KWD",
          name: "Kuwaiti Dinar",
          symbol: "KWD",
          decimalPlaces: 3,
        });
      });
    });

    describe("name/text match via searchMetadataByText", () => {
      it("matches an exact currency name (e.g., 'Canadian Dollar')", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("Canadian Dollar");

        expect(result).toEqual({
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
        });
      });

      it("matches exact name case-insensitively", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("japanese yen");

        expect(result).toEqual({
          code: "JPY",
          name: "Japanese Yen",
          symbol: "\u00A5",
          decimalPlaces: 0,
        });
      });

      it("matches a substring uniquely (e.g., 'Ringgit' matches 'Malaysian Ringgit')", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("Ringgit");

        expect(result).toEqual({
          code: "MYR",
          name: "Malaysian Ringgit",
          symbol: "RM",
          decimalPlaces: 2,
        });
      });

      it("matches a unique substring like 'Baht' for Thai Baht", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("Baht");

        expect(result).toEqual({
          code: "THB",
          name: "Thai Baht",
          symbol: "\u0E3F",
          decimalPlaces: 2,
        });
      });

      it("returns null for ambiguous substring matching multiple currencies (e.g., 'Dollar')", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ quotes: [] }),
        });

        const result = await service.lookupCurrency("Dollar");

        expect(result).toBeNull();
      });

      it("returns null for ambiguous 'Krone' matching multiple currencies and no Yahoo results", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ quotes: [] }),
        });

        const result = await service.lookupCurrency("Krone");

        expect(result).toBeNull();
      });
    });

    describe("Yahoo Finance fallback", () => {
      it("uses Yahoo Finance search when no metadata matches and returns the currency", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "MYRUSD=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("Ringgit Malaysia");

        expect(result).toEqual({
          code: "MYR",
          name: "Malaysian Ringgit",
          symbol: "RM",
          decimalPlaces: 2,
        });
      });

      it("extracts base currency from 6-char forex pair when base matches query", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "EURUSD=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("EUR something unknown");

        expect(result).toEqual({
          code: "EUR",
          name: "Euro",
          symbol: "\u20AC",
          decimalPlaces: 2,
        });
      });

      it("extracts quote currency from 6-char forex pair when quote matches query", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "JPYUSD=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("USD");

        expect(result).toEqual({
          code: "USD",
          name: "US Dollar",
          symbol: "$",
          decimalPlaces: 2,
        });
      });

      it("defaults to base currency when neither part of pair matches query", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "GBPJPY=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("some unknown forex");

        expect(result).toEqual({
          code: "GBP",
          name: "British Pound",
          symbol: "\u00A3",
          decimalPlaces: 2,
        });
      });

      it("handles non-6-char symbol by returning uppercased original query", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "BTC=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("btc crypto");

        expect(result).toEqual({
          code: "BTC CRYPTO",
          name: "BTC CRYPTO",
          symbol: "BTC CRYPTO",
          decimalPlaces: 2,
        });
      });

      it("matches quotes by =X suffix even without quoteType CURRENCY", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "ZARUSD=X", quoteType: "OTHER" }],
            }),
        });

        const result = await service.lookupCurrency("some rand query");

        expect(result).toEqual({
          code: "ZAR",
          name: "South African Rand",
          symbol: "R",
          decimalPlaces: 2,
        });
      });

      it("returns null when Yahoo returns no currency quotes", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "AAPL", quoteType: "EQUITY" }],
            }),
        });

        const result = await service.lookupCurrency("something weird");

        expect(result).toBeNull();
      });

      it("returns null when Yahoo returns empty quotes array", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ quotes: [] }),
        });

        const result = await service.lookupCurrency("xyznonexistent");

        expect(result).toBeNull();
      });

      it("returns null when Yahoo returns no quotes property", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({}),
        });

        const result = await service.lookupCurrency("xyznonexistent");

        expect(result).toBeNull();
      });

      it("uses fallback name/symbol when Yahoo result code is not in CURRENCY_METADATA", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "ABCDEF=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("something exotic");

        expect(result).toEqual({
          code: "ABC",
          name: "ABC",
          symbol: "ABC",
          decimalPlaces: 2,
        });
      });
    });

    describe("error handling", () => {
      it("returns null when Yahoo Finance search returns non-ok status", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: false,
          status: 500,
        });

        const result = await service.lookupCurrency("something unknown");

        expect(result).toBeNull();
      });

      it("returns null when fetch throws a network error", async () => {
        (global.fetch as jest.Mock).mockRejectedValue(
          new Error("fetch failed"),
        );

        const result = await service.lookupCurrency("something unknown");

        expect(result).toBeNull();
      });

      it("returns null when json() parsing throws", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.reject(new Error("Invalid JSON")),
        });

        const result = await service.lookupCurrency("something unknown");

        expect(result).toBeNull();
      });

      it("trims whitespace from query before processing", async () => {
        (global.fetch as jest.Mock).mockResolvedValue({ ok: true });

        const result = await service.lookupCurrency("  CAD  ");

        expect(result).toEqual({
          code: "CAD",
          name: "Canadian Dollar",
          symbol: "CA$",
          decimalPlaces: 2,
        });
      });
    });
  });
});
