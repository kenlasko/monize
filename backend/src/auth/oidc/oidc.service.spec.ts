import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OidcService } from "./oidc.service";

// Mock the entire openid-client module
jest.mock("openid-client", () => {
  const mockAuthorizationUrl = jest
    .fn()
    .mockReturnValue("https://issuer.example.com/auth?scope=openid");
  const mockCallback = jest
    .fn()
    .mockResolvedValue({ access_token: "at-123", id_token: "id-123" });
  const mockUserinfo = jest
    .fn()
    .mockResolvedValue({ sub: "oidc-user-1", email: "user@example.com" });

  const MockClient = jest.fn().mockImplementation(() => ({
    authorizationUrl: mockAuthorizationUrl,
    callback: mockCallback,
    userinfo: mockUserinfo,
  }));

  const mockDiscover = jest.fn().mockResolvedValue({
    metadata: { issuer: "https://issuer.example.com" },
    Client: MockClient,
  });

  return {
    Issuer: {
      discover: mockDiscover,
    },
    generators: {
      state: jest.fn().mockReturnValue("random-state-value"),
      nonce: jest.fn().mockReturnValue("random-nonce-value"),
    },
    // Re-export for test access
    __mockDiscover: mockDiscover,
    __MockClient: MockClient,
    __mockAuthorizationUrl: mockAuthorizationUrl,
    __mockCallback: mockCallback,
    __mockUserinfo: mockUserinfo,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const oidcClient = require("openid-client");

describe("OidcService", () => {
  let service: OidcService;
  let configService: Record<string, jest.Mock>;

  const fullConfig: Record<string, string> = {
    OIDC_ISSUER_URL: "https://issuer.example.com",
    OIDC_CLIENT_ID: "my-client-id",
    OIDC_CLIENT_SECRET: "my-client-secret",
    OIDC_CALLBACK_URL: "http://localhost:3001/api/v1/auth/oidc/callback",
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    configService = {
      get: jest.fn((key: string) => fullConfig[key]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OidcService,
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    service = module.get<OidcService>(OidcService);
  });

  describe("enabled", () => {
    it("returns false before initialization", () => {
      expect(service.enabled).toBe(false);
    });

    it("returns true after successful initialization", async () => {
      await service.initialize();
      expect(service.enabled).toBe(true);
    });
  });

  describe("initialize()", () => {
    it("discovers the OIDC issuer and creates a client", async () => {
      const result = await service.initialize();

      expect(result).toBe(true);
      expect(oidcClient.Issuer.discover).toHaveBeenCalledWith(
        "https://issuer.example.com",
      );
      expect(service.enabled).toBe(true);
    });

    it("returns false when OIDC_ISSUER_URL is not configured", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "OIDC_ISSUER_URL") return undefined;
        return fullConfig[key];
      });

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.enabled).toBe(false);
      expect(oidcClient.Issuer.discover).not.toHaveBeenCalled();
    });

    it("returns false when OIDC_CLIENT_ID is not configured", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "OIDC_CLIENT_ID") return undefined;
        return fullConfig[key];
      });

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.enabled).toBe(false);
    });

    it("returns false when OIDC_CLIENT_SECRET is not configured", async () => {
      configService.get.mockImplementation((key: string) => {
        if (key === "OIDC_CLIENT_SECRET") return undefined;
        return fullConfig[key];
      });

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.enabled).toBe(false);
    });

    it("returns false and logs error when discovery fails", async () => {
      oidcClient.Issuer.discover.mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await service.initialize();

      expect(result).toBe(false);
      expect(service.enabled).toBe(false);
    });
  });

  describe("getAuthorizationUrl()", () => {
    it("throws when client is not initialized", () => {
      expect(() => service.getAuthorizationUrl("state-1", "nonce-1")).toThrow(
        "OIDC client not initialized",
      );
    });

    it("returns authorization URL after initialization", async () => {
      await service.initialize();

      const url = service.getAuthorizationUrl("state-1", "nonce-1");

      expect(url).toBe("https://issuer.example.com/auth?scope=openid");
      expect(oidcClient.__mockAuthorizationUrl).toHaveBeenCalledWith({
        scope: "openid profile email",
        state: "state-1",
        nonce: "nonce-1",
      });
    });
  });

  describe("handleCallback()", () => {
    it("throws when client is not initialized", async () => {
      await expect(
        service.handleCallback({ code: "abc" }, "state-1", "nonce-1"),
      ).rejects.toThrow("OIDC client not initialized");
    });

    it("exchanges the authorization code for tokens", async () => {
      await service.initialize();

      const tokenSet = await service.handleCallback(
        { code: "auth-code-123" },
        "state-1",
        "nonce-1",
      );

      expect(tokenSet).toEqual({
        access_token: "at-123",
        id_token: "id-123",
      });
      expect(oidcClient.__mockCallback).toHaveBeenCalledWith(
        "http://localhost:3001/api/v1/auth/oidc/callback",
        { code: "auth-code-123" },
        { state: "state-1", nonce: "nonce-1" },
      );
    });
  });

  describe("getUserInfo()", () => {
    it("throws when client is not initialized", async () => {
      await expect(service.getUserInfo("access-token")).rejects.toThrow(
        "OIDC client not initialized",
      );
    });

    it("returns user info from the OIDC provider", async () => {
      await service.initialize();

      const userInfo = await service.getUserInfo("access-token-123");

      expect(userInfo).toEqual({
        sub: "oidc-user-1",
        email: "user@example.com",
      });
      expect(oidcClient.__mockUserinfo).toHaveBeenCalledWith(
        "access-token-123",
      );
    });
  });

  describe("generateState()", () => {
    it("returns a random state value", () => {
      const state = service.generateState();
      expect(state).toBe("random-state-value");
      expect(oidcClient.generators.state).toHaveBeenCalled();
    });
  });

  describe("generateNonce()", () => {
    it("returns a random nonce value", () => {
      const nonce = service.generateNonce();
      expect(nonce).toBe("random-nonce-value");
      expect(oidcClient.generators.nonce).toHaveBeenCalled();
    });
  });
});
