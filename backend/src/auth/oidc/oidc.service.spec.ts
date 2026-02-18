import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OidcService } from "./oidc.service";

const mockServerMetadata = jest
  .fn()
  .mockReturnValue({ issuer: "https://issuer.example.com" });

const mockDiscovery = jest.fn().mockResolvedValue({
  serverMetadata: mockServerMetadata,
});

const mockBuildAuthorizationUrl = jest.fn().mockReturnValue({
  href: "https://issuer.example.com/auth?scope=openid",
});

const mockAuthorizationCodeGrant = jest.fn().mockResolvedValue({
  access_token: "at-123",
  claims: () => ({ sub: "oidc-user-1" }),
});

const mockFetchUserInfo = jest
  .fn()
  .mockResolvedValue({ sub: "oidc-user-1", email: "user@example.com" });

const mockRandomState = jest.fn().mockReturnValue("random-state-value");
const mockRandomNonce = jest.fn().mockReturnValue("random-nonce-value");

jest.mock("openid-client", () => ({
  discovery: (...args: unknown[]) => mockDiscovery(...args),
  buildAuthorizationUrl: (...args: unknown[]) =>
    mockBuildAuthorizationUrl(...args),
  authorizationCodeGrant: (...args: unknown[]) =>
    mockAuthorizationCodeGrant(...args),
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
  randomState: () => mockRandomState(),
  randomNonce: () => mockRandomNonce(),
}));

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
    it("discovers the OIDC issuer and creates a configuration", async () => {
      const result = await service.initialize();

      expect(result).toBe(true);
      expect(mockDiscovery).toHaveBeenCalledWith(
        expect.any(URL),
        "my-client-id",
        "my-client-secret",
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
      expect(mockDiscovery).not.toHaveBeenCalled();
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
      mockDiscovery.mockRejectedValueOnce(new Error("Network error"));

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
      expect(mockBuildAuthorizationUrl).toHaveBeenCalledWith(
        expect.anything(),
        {
          redirect_uri: "http://localhost:3001/api/v1/auth/oidc/callback",
          scope: "openid profile email",
          state: "state-1",
          nonce: "nonce-1",
        },
      );
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

      const result = await service.handleCallback(
        { code: "auth-code-123" },
        "state-1",
        "nonce-1",
      );

      expect(result).toEqual({
        access_token: "at-123",
        sub: "oidc-user-1",
      });
      expect(mockAuthorizationCodeGrant).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(URL),
        {
          expectedState: "state-1",
          expectedNonce: "nonce-1",
        },
      );
    });

    it("throws when no access token is received", async () => {
      await service.initialize();
      mockAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: undefined,
        claims: () => ({ sub: "oidc-user-1" }),
      });

      await expect(
        service.handleCallback({ code: "abc" }, "state-1", "nonce-1"),
      ).rejects.toThrow("No access token received from OIDC provider");
    });

    it("throws when no subject claim in ID token", async () => {
      await service.initialize();
      mockAuthorizationCodeGrant.mockResolvedValueOnce({
        access_token: "at-123",
        claims: () => undefined,
      });

      await expect(
        service.handleCallback({ code: "abc" }, "state-1", "nonce-1"),
      ).rejects.toThrow("No subject claim in ID token");
    });
  });

  describe("getUserInfo()", () => {
    it("throws when client is not initialized", async () => {
      await expect(
        service.getUserInfo("access-token", "sub-1"),
      ).rejects.toThrow("OIDC client not initialized");
    });

    it("returns user info from the OIDC provider", async () => {
      await service.initialize();

      const userInfo = await service.getUserInfo(
        "access-token-123",
        "oidc-user-1",
      );

      expect(userInfo).toEqual({
        sub: "oidc-user-1",
        email: "user@example.com",
      });
      expect(mockFetchUserInfo).toHaveBeenCalledWith(
        expect.anything(),
        "access-token-123",
        "oidc-user-1",
      );
    });
  });

  describe("generateState()", () => {
    it("returns a random state value", () => {
      const state = service.generateState();
      expect(state).toBe("random-state-value");
      expect(mockRandomState).toHaveBeenCalled();
    });
  });

  describe("generateNonce()", () => {
    it("returns a random nonce value", () => {
      const nonce = service.generateNonce();
      expect(nonce).toBe("random-nonce-value");
      expect(mockRandomNonce).toHaveBeenCalled();
    });
  });
});
