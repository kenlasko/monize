import { Test, TestingModule } from "@nestjs/testing";
import { QuoteProviderRegistry } from "./quote-provider.registry";
import { YahooFinanceService } from "../yahoo-finance.service";
import { MsnFinanceService } from "../msn-finance.service";
import { MfApiService } from "../mfapi.service";
import { Security } from "../entities/security.entity";

describe("QuoteProviderRegistry", () => {
  let registry: QuoteProviderRegistry;

  const yahooMock = { name: "yahoo" } as unknown as YahooFinanceService;
  const msnMock = { name: "msn" } as unknown as MsnFinanceService;
  const mfapiMock = { name: "mfapi" } as unknown as MfApiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuoteProviderRegistry,
        { provide: YahooFinanceService, useValue: yahooMock },
        { provide: MsnFinanceService, useValue: msnMock },
        { provide: MfApiService, useValue: mfapiMock },
      ],
    }).compile();
    registry = module.get(QuoteProviderRegistry);
  });

  it("getByName resolves yahoo, msn, and mfapi", () => {
    expect(registry.getByName("yahoo").name).toBe("yahoo");
    expect(registry.getByName("msn").name).toBe("msn");
    expect(registry.getByName("mfapi").name).toBe("mfapi");
  });

  it("resolveForSecurity honors the security's explicit override", () => {
    const security = { quoteProvider: "msn" } as Security;
    const ordered = registry.resolveForSecurity(security, "yahoo");
    expect(ordered.map((p) => p.name)).toEqual(["msn", "yahoo", "mfapi"]);
  });

  it("resolveForSecurity falls back to user default when security has no override", () => {
    const security = { quoteProvider: null } as Security;
    const ordered = registry.resolveForSecurity(security, "msn");
    expect(ordered.map((p) => p.name)).toEqual(["msn", "yahoo", "mfapi"]);
  });

  it("resolveForSecurity falls back to yahoo when both security and user have no preference", () => {
    const security = { quoteProvider: null } as Security;
    const ordered = registry.resolveForSecurity(security, null);
    expect(ordered.map((p) => p.name)).toEqual(["yahoo", "msn", "mfapi"]);
  });

  it("listAll returns all three providers", () => {
    expect(
      registry
        .listAll()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["mfapi", "msn", "yahoo"]);
  });
});
