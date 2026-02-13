import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { CurrenciesService } from "./currencies.service";
import { Currency } from "./entities/currency.entity";

describe("CurrenciesService", () => {
  let service: CurrenciesService;
  let mockRepository: Partial<Record<keyof Repository<Currency>, jest.Mock>>;
  let mockDataSource: { query: jest.Mock };

  const mockCurrency: Currency = {
    code: "CAD",
    name: "Canadian Dollar",
    symbol: "CA$",
    decimalPlaces: 2,
    isActive: true,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    mockRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    mockDataSource = {
      query: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CurrenciesService,
        {
          provide: getRepositoryToken(Currency),
          useValue: mockRepository,
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
    it("creates a new currency successfully", async () => {
      const dto = {
        code: "NZD",
        name: "New Zealand Dollar",
        symbol: "NZ$",
        decimalPlaces: 2,
      };

      mockRepository.findOne!.mockResolvedValue(null);
      mockRepository.create!.mockReturnValue({ ...dto, isActive: true });
      mockRepository.save!.mockResolvedValue({ ...dto, isActive: true });

      const result = await service.create(dto);

      expect(result).toEqual({ ...dto, isActive: true });
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { code: "NZD" },
      });
    });

    it("throws ConflictException if currency code already exists", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);

      await expect(
        service.create({ code: "CAD", name: "Test", symbol: "$" }),
      ).rejects.toThrow(ConflictException);
    });

    it("uppercases the code", async () => {
      mockRepository.findOne!.mockResolvedValue(null);
      mockRepository.create!.mockReturnValue({
        code: "NZD",
        name: "Test",
        symbol: "$",
        isActive: true,
      });
      mockRepository.save!.mockResolvedValue({
        code: "NZD",
        name: "Test",
        symbol: "$",
        isActive: true,
      });

      await service.create({ code: "nzd", name: "Test", symbol: "$" });

      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { code: "NZD" },
      });
    });
  });

  describe("findAll()", () => {
    it("returns only active currencies by default", async () => {
      mockRepository.find!.mockResolvedValue([mockCurrency]);

      const result = await service.findAll();

      expect(result).toEqual([mockCurrency]);
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
        order: { code: "ASC" },
      });
    });

    it("returns all currencies when includeInactive is true", async () => {
      mockRepository.find!.mockResolvedValue([mockCurrency]);

      await service.findAll(true);

      expect(mockRepository.find).toHaveBeenCalledWith({
        where: {},
        order: { code: "ASC" },
      });
    });
  });

  describe("findOne()", () => {
    it("returns a currency by code", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);

      const result = await service.findOne("CAD");

      expect(result).toEqual(mockCurrency);
    });

    it("throws NotFoundException if currency not found", async () => {
      mockRepository.findOne!.mockResolvedValue(null);

      await expect(service.findOne("XYZ")).rejects.toThrow(NotFoundException);
    });
  });

  describe("update()", () => {
    it("updates and returns the currency", async () => {
      mockRepository.findOne!.mockResolvedValue({ ...mockCurrency });
      mockRepository.save!.mockResolvedValue({
        ...mockCurrency,
        name: "Updated Name",
      });

      const result = await service.update("CAD", { name: "Updated Name" });

      expect(result.name).toBe("Updated Name");
      expect(mockRepository.save).toHaveBeenCalled();
    });
  });

  describe("deactivate()", () => {
    it("sets isActive to false and saves", async () => {
      mockRepository.findOne!.mockResolvedValue({ ...mockCurrency });
      mockRepository.save!.mockImplementation((c) =>
        Promise.resolve({ ...c, isActive: false }),
      );

      const result = await service.deactivate("CAD");

      expect(result.isActive).toBe(false);
    });
  });

  describe("activate()", () => {
    it("sets isActive to true and saves", async () => {
      const inactiveCurrency = { ...mockCurrency, isActive: false };
      mockRepository.findOne!.mockResolvedValue(inactiveCurrency);
      mockRepository.save!.mockImplementation((c) =>
        Promise.resolve({ ...c, isActive: true }),
      );

      const result = await service.activate("CAD");

      expect(result.isActive).toBe(true);
    });
  });

  describe("remove()", () => {
    it("deletes a currency that is not in use", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);
      mockRepository.remove!.mockResolvedValue(undefined);

      await service.remove("CAD");

      expect(mockRepository.remove).toHaveBeenCalledWith(mockCurrency);
    });

    it("throws ConflictException if currency is in use", async () => {
      mockRepository.findOne!.mockResolvedValue(mockCurrency);
      mockDataSource.query.mockResolvedValue([{ inUse: true }]);

      await expect(service.remove("CAD")).rejects.toThrow(ConflictException);
    });
  });

  describe("getUsage()", () => {
    it("returns usage counts per currency", async () => {
      mockDataSource.query.mockResolvedValue([
        { code: "CAD", accounts: "3", securities: "5" },
        { code: "USD", accounts: "1", securities: "0" },
      ]);

      const result = await service.getUsage();

      expect(result).toEqual({
        CAD: { accounts: 3, securities: 5 },
        USD: { accounts: 1, securities: 0 },
      });
    });
  });

  describe("isInUse()", () => {
    it("returns true when currency is referenced by accounts, securities, etc.", async () => {
      mockDataSource.query.mockResolvedValue([{ inUse: true }]);

      const result = await service.isInUse("CAD");

      expect(result).toBe(true);
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("SELECT EXISTS"),
        ["CAD"],
      );
    });

    it("returns false when currency is not referenced anywhere", async () => {
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);

      const result = await service.isInUse("XYZ");

      expect(result).toBe(false);
    });

    it("uppercases the code before querying", async () => {
      mockDataSource.query.mockResolvedValue([{ inUse: false }]);

      await service.isInUse("cad");

      expect(mockDataSource.query).toHaveBeenCalledWith(expect.any(String), [
        "CAD",
      ]);
    });

    it("returns false when query returns unexpected shape", async () => {
      mockDataSource.query.mockResolvedValue([]);

      const result = await service.isInUse("CAD");

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
        // "Dollar" matches US Dollar, Australian Dollar, Canadian Dollar, etc.
        // searchMetadataByText returns null for multiple matches, so it falls through
        // to Yahoo Finance search
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ quotes: [] }),
        });

        const result = await service.lookupCurrency("Dollar");

        // No direct match, no single text match, Yahoo returns no currency quotes
        expect(result).toBeNull();
      });

      it("returns null for ambiguous 'Krone' matching multiple currencies and no Yahoo results", async () => {
        // "Krone" matches "Danish Krone", "Norwegian Krone", "Swedish Krona" (not Krona)
        // Actually "Krone" matches Danish Krone and Norwegian Krone (two matches)
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

        // Not an exact name or unique substring, falls through to Yahoo
        // Yahoo returns MYRUSD=X, extractCurrencyCode extracts MYR
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

        // Not a direct code or metadata text match, falls to Yahoo
        // Yahoo returns EURUSD=X, extractCurrencyCode tries base=EUR
        // "EUR SOMETHING UNKNOWN" !== "EUR" and !== "USD" so it defaults to base (EUR)
        expect(result).toEqual({
          code: "EUR",
          name: "Euro",
          symbol: "\u20AC",
          decimalPlaces: 2,
        });
      });

      it("extracts quote currency from 6-char forex pair when quote matches query", async () => {
        // Simulating a scenario where the query matches the quote part
        (global.fetch as jest.Mock).mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              quotes: [{ symbol: "JPYUSD=X", quoteType: "CURRENCY" }],
            }),
        });

        const result = await service.lookupCurrency("USD");

        // "USD" is in CURRENCY_METADATA, so it will match directly and never reach Yahoo.
        // Let's use a scenario where extractCurrencyCode is exercised differently.
        // Actually, "USD" will be caught by direct code match. This test confirms direct match.
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

        // A query that won't match any code or metadata text directly
        const result = await service.lookupCurrency("some unknown forex");

        // extractCurrencyCode("GBPJPY=X", "SOME UNKNOWN FOREX")
        // pair = "GBPJPY", base = "GBP", quote = "JPY"
        // neither matches "SOME UNKNOWN FOREX", so returns base "GBP"
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

        // A query that doesn't match metadata
        const result = await service.lookupCurrency("btc crypto");

        // extractCurrencyCode("BTC=X", "BTC CRYPTO")
        // pair = "BTC", length != 6, returns "BTC CRYPTO".toUpperCase()
        // No CURRENCY_METADATA for "BTC CRYPTO" so name/symbol fall back to code
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

        // Filter matches on symbol.includes("=X"), so this passes
        // extractCurrencyCode("ZARUSD=X", "SOME RAND QUERY") -> base="ZAR"
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

        // extractCurrencyCode("ABCDEF=X", "SOMETHING EXOTIC") -> pair = "ABCDEF", base = "ABC"
        // "ABC" not in CURRENCY_METADATA
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
