import { Test, TestingModule } from "@nestjs/testing";
import { MfApiService } from "./mfapi.service";

describe("MfApiService", () => {
  let service: MfApiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MfApiService],
    }).compile();

    service = module.get<MfApiService>(MfApiService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
    expect(service.name).toBe("mfapi");
  });

  describe("fetchQuote", () => {
    it("should return null for non-numeric scheme code", async () => {
      const quote = await service.fetchQuote("INVALID_CODE");
      expect(quote).toBeNull();
    });

    it("should fetch quote successfully for valid numeric scheme code", async () => {
      const mockResponse = {
        meta: {
          scheme_code: 122639,
          scheme_name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
        },
        data: [
          { date: "24-07-2026", nav: "78.4521" },
          { date: "23-07-2026", nav: "78.1200" },
        ],
        status: "SUCCESS",
      };

      jest.spyOn(service as any, "httpGetJson").mockResolvedValue(mockResponse);

      const quote = await service.fetchQuote("122639");
      expect(quote).not.toBeNull();
      expect(quote?.symbol).toBe("122639");
      expect(quote?.regularMarketPrice).toBe(78.4521);
      expect(quote?.currencyCode).toBe("INR");
      expect(quote?.provider).toBe("mfapi");
    });

    it("should return null on HTTP error or missing NAV", async () => {
      jest
        .spyOn(service as any, "httpGetJson")
        .mockRejectedValue(new Error("HTTP 404"));

      const quote = await service.fetchQuote("999999");
      expect(quote).toBeNull();
    });

    it("should return null when the NAV value is malformed (non-numeric)", async () => {
      const mockResponse = {
        meta: { scheme_code: 122639 },
        data: [{ date: "24-07-2026", nav: "NOT_A_NUMBER" }],
        status: "SUCCESS",
      };

      jest.spyOn(service as any, "httpGetJson").mockResolvedValue(mockResponse);

      const quote = await service.fetchQuote("122639");
      expect(quote).toBeNull();
    });
  });

  describe("lookupSecurityMany / search", () => {
    it("should return search results mapped to SecurityLookupResult", async () => {
      const mockSearchResults = [
        { schemeCode: 122639, schemeName: "Parag Parikh Flexi Cap Fund" },
        { schemeCode: 118834, schemeName: "HDFC Small Cap Fund" },
      ];

      jest
        .spyOn(service as any, "httpGetJson")
        .mockResolvedValue(mockSearchResults);

      const results = await service.lookupSecurityMany("Parag Parikh");
      expect(results).toHaveLength(2);
      expect(results[0].symbol).toBe("122639");
      expect(results[0].currencyCode).toBe("INR");
      expect(results[0].provider).toBe("mfapi");
    });

    it("should return empty array when query is too short", async () => {
      const results = await service.lookupSecurityMany("a");
      expect(results).toEqual([]);
    });
  });

  describe("fetchHistorical", () => {
    it("should return historical prices ordered by date", async () => {
      const mockResponse = {
        meta: { scheme_code: 122639 },
        data: [
          { date: "24-07-2026", nav: "78.45" },
          { date: "23-07-2026", nav: "78.12" },
        ],
      };

      jest.spyOn(service as any, "httpGetJson").mockResolvedValue(mockResponse);

      const history = await service.fetchHistorical("122639");
      expect(history).not.toBeNull();
      expect(history?.length).toBe(2);
      expect(history?.[0].close).toBe(78.12);
      expect(history?.[1].close).toBe(78.45);
    });

    it("should skip entries with malformed NAV values", async () => {
      const mockResponse = {
        meta: { scheme_code: 122639 },
        data: [
          { date: "24-07-2026", nav: "78.45" },
          { date: "23-07-2026", nav: "NOT_A_NUMBER" },
        ],
      };

      jest.spyOn(service as any, "httpGetJson").mockResolvedValue(mockResponse);

      const history = await service.fetchHistorical("122639");
      expect(history?.length).toBe(1);
      expect(history?.[0].close).toBe(78.45);
    });
  });
});
