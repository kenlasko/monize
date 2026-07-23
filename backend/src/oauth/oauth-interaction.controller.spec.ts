import { OAuthInteractionController } from "./oauth-interaction.controller";
import { getRequestContext } from "../common/request-context";

// resolveCookieUser reads the user under withUserContext(payload.sub), which
// validates the id is a UUID (a real auth_token cookie carries a UUID sub).
const USER_ID = "11111111-1111-1111-1111-111111111111";

describe("OAuthInteractionController", () => {
  function makeController(overrides: {
    interactionDetails: jest.Mock;
    interactionFinished?: jest.Mock;
    Grant?: any;
    jwtVerify?: jest.Mock;
    findUser?: jest.Mock;
    publicUrl?: string;
    mcpResourceUrl?: string;
  }) {
    const interactionFinished = overrides.interactionFinished ?? jest.fn();
    const provider = {
      interactionDetails: overrides.interactionDetails,
      interactionFinished,
      Client: {
        find: jest.fn().mockImplementation((id: string) => {
          if (id === "claude-desktop") {
            return Promise.resolve({
              clientId: "claude-desktop",
              clientName: "Claude Desktop",
              clientUri: null,
            });
          }
          return Promise.resolve(null);
        }),
      },
      Grant:
        overrides.Grant ??
        class MockGrant {
          accountId: string;
          clientId: string;
          oidcScopes: string[] = [];
          resourceScopes: Array<{ resource: string; scope: string }> = [];
          constructor(args: { accountId: string; clientId: string }) {
            this.accountId = args.accountId;
            this.clientId = args.clientId;
          }
          static find = jest.fn().mockResolvedValue(null);
          addOIDCScope(s: string) {
            this.oidcScopes.push(s);
          }
          addOIDCClaims(_c: string[]) {}
          addResourceScope(r: string, s: string) {
            this.resourceScopes.push({ resource: r, scope: s });
          }
          save() {
            return Promise.resolve("grant-id-1");
          }
        },
    };
    const providerService = {
      getProvider: jest.fn().mockReturnValue(provider),
      getMcpResourceUrl: jest
        .fn()
        .mockReturnValue(
          overrides.mcpResourceUrl ?? "https://app.monize.test/api/v1/mcp",
        ),
    } as any;
    const jwtService = {
      verifyAsync:
        overrides.jwtVerify ??
        jest.fn().mockResolvedValue({ sub: USER_ID, type: undefined }),
    } as any;
    const authService = {
      getUserById:
        overrides.findUser ??
        jest.fn().mockResolvedValue({
          id: USER_ID,
          email: "u@e.com",
          isActive: true,
          mustChangePassword: false,
        }),
    } as any;
    const configService = {
      get: jest
        .fn()
        .mockReturnValue(overrides.publicUrl ?? "https://app.monize.test"),
    } as any;
    const controller = new OAuthInteractionController(
      providerService,
      jwtService,
      authService,
      configService,
    );
    return { controller, provider, interactionFinished, providerService };
  }

  function makeRes() {
    return {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
      setHeader: jest.fn(),
      redirect: jest.fn(),
      json: jest.fn(),
    } as any;
  }

  describe("GET /oauth-consent/:uid", () => {
    it("redirects to login when login prompt and no auth_token cookie", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "login" },
          params: {},
        }),
      });
      const req = {
        cookies: {},
        originalUrl: "/api/v1/oauth-consent/u",
      } as any;
      const res = makeRes();

      await controller.render(req, res);

      expect(res.redirect).toHaveBeenCalledWith(
        302,
        expect.stringContaining(
          "/login?returnTo=%2Fapi%2Fv1%2Foauth-consent%2Fu",
        ),
      );
    });

    it("finishes login interaction when user is authenticated", async () => {
      const { controller, interactionFinished } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "login" },
          params: {},
        }),
      });
      const req = {
        cookies: { auth_token: "valid" },
      } as any;
      const res = makeRes();

      await controller.render(req, res);

      expect(interactionFinished).toHaveBeenCalledWith(
        req,
        res,
        { login: { accountId: USER_ID } },
        { mergeWithLastSubmission: false },
      );
    });

    // RLS (task C1): the consent pages authenticate from the auth_token cookie,
    // so the user read runs under withUserContext(sub) -- never a system bypass.
    it("resolves the cookie user under withUserContext(sub) (no bypass)", async () => {
      let ctx: ReturnType<typeof getRequestContext>;
      const findUser = jest.fn().mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({
          id: USER_ID,
          email: "u@e.com",
          isActive: true,
          mustChangePassword: false,
        });
      });
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "login" },
          params: {},
        }),
        findUser,
      });
      const req = { cookies: { auth_token: "valid" } } as any;
      const res = makeRes();

      await controller.render(req, res);

      expect(findUser).toHaveBeenCalledWith(USER_ID);
      expect(ctx).toEqual({ userId: USER_ID });
      expect(ctx?.system).toBeUndefined();
    });

    it("renders consent HTML for authenticated user with valid prompt", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "consent" },
          params: {
            client_id: "claude-desktop",
            client_name: "Claude Desktop",
            scope: "monize:read monize:write",
            resource: "https://app.monize.test/api/v1/mcp",
          },
        }),
      });
      const req = { cookies: { auth_token: "valid" } } as any;
      const res = makeRes();

      await controller.render(req, res);

      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/html; charset=utf-8",
      );
      expect(res.send).toHaveBeenCalledWith(
        expect.stringContaining("Claude Desktop"),
      );
      expect(res.send).toHaveBeenCalledWith(
        expect.stringContaining("Read your financial data"),
      );
    });

    it("renders a friendly completed page when the interaction is stale (consumed/expired)", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockRejectedValue(
          Object.assign(new Error("invalid_request"), {
            name: "SessionNotFound",
          }),
        ),
      });
      const req = { cookies: {} } as any;
      const res = makeRes();

      await controller.render(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        expect.stringContaining("authorization is already complete"),
      );
    });

    it("rejects unknown prompt names", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "unknown_prompt" },
          params: {},
        }),
      });
      const req = { cookies: {} } as any;
      const res = makeRes();

      await controller.render(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe("POST /oauth-consent/:uid/confirm", () => {
    const consentDetails = {
      missingOIDCScope: ["openid", "profile", "monize:read", "monize:write"],
      missingResourceScopes: {
        "https://app.monize.test/api/v1/mcp": ["monize:read", "monize:write"],
      },
    };

    it("renders a friendly completed page when the interaction is already consumed", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockRejectedValue(
          Object.assign(new Error("invalid_request"), {
            name: "SessionNotFound",
          }),
        ),
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith(
        expect.stringContaining("authorization is already complete"),
      );
    });

    it("returns 401 when user not authenticated", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "consent", details: consentDetails },
          params: { client_id: "c" },
        }),
        jwtVerify: jest.fn().mockRejectedValue(new Error("invalid")),
      });
      const req = { cookies: {}, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("rejects when interaction is not awaiting consent", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "login" },
          params: {},
        }),
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("grants every missing OIDC and resource scope, then finishes the interaction", async () => {
      const grant = {
        addOIDCScope: jest.fn(),
        addOIDCClaims: jest.fn(),
        addResourceScope: jest.fn(),
        save: jest.fn().mockResolvedValue("grant-id-1"),
      };
      class GrantMock {
        constructor() {
          return grant;
        }
        static find = jest.fn().mockResolvedValue(null);
      }
      const { controller, interactionFinished } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: {
            name: "consent",
            details: {
              missingOIDCScope: ["openid", "profile", "monize:read"],
              missingOIDCClaims: ["sub", "email"],
              missingResourceScopes: {
                "https://app.monize.test/api/v1/mcp": ["monize:read"],
              },
            },
          },
          params: { client_id: "claude-desktop" },
          session: { accountId: USER_ID },
        }),
        Grant: GrantMock as any,
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res);

      // OIDC identity scopes (openid, profile) AND the resource scope are all
      // granted -- not just the monize:* subset -- so the consent check clears
      // and the provider stops re-prompting with a new uid.
      expect(grant.addOIDCScope).toHaveBeenCalledWith(
        "openid profile monize:read",
      );
      expect(grant.addOIDCClaims).toHaveBeenCalledWith(["sub", "email"]);
      expect(grant.addResourceScope).toHaveBeenCalledWith(
        "https://app.monize.test/api/v1/mcp",
        "monize:read",
      );
      expect(interactionFinished).toHaveBeenCalledWith(
        req,
        res,
        { consent: { grantId: "grant-id-1" } },
        { mergeWithLastSubmission: true },
      );
    });

    it("rejects when authenticated user does not match the interaction's session user", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "consent", details: consentDetails },
          params: { client_id: "c" },
          session: { accountId: "other-user" },
        }),
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe("POST /oauth-consent/:uid/abort", () => {
    it("finishes the interaction with access_denied", async () => {
      const { controller, interactionFinished } = makeController({
        interactionDetails: jest.fn(),
      });
      const req = {} as any;
      const res = makeRes();

      await controller.abort(req, res);

      expect(interactionFinished).toHaveBeenCalledWith(
        req,
        res,
        expect.objectContaining({ error: "access_denied" }),
        { mergeWithLastSubmission: false },
      );
    });

    it("renders completed page when abort fails (stale interaction)", async () => {
      const finishedFn = jest.fn().mockRejectedValueOnce(
        Object.assign(new Error("session not found"), {
          name: "SessionNotFound",
        }),
      );
      const { controller } = makeController({
        interactionDetails: jest.fn(),
        interactionFinished: finishedFn,
      });
      const req = {} as any;
      const res = makeRes();
      await controller.abort(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  // ─── Branch coverage extras ─────────────────────────────────────────

  describe("render: consent prompt with no cookie redirects to login", () => {
    it("redirects to login when consent prompt has no auth_token", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
      });
      const req = { cookies: {}, originalUrl: "/oauth-consent/u1" } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.redirect).toHaveBeenCalledWith(302, expect.any(String));
    });
  });

  describe("render: lookupClient branches", () => {
    it("uses clientId as name when client lookup returns null", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent" },
          params: { client_id: "unknown-client", scope: "monize:read" },
        }),
      });
      const req = { cookies: { auth_token: "tok" } } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.send).toHaveBeenCalled();
    });

    it("uses fallback when clientId is empty (lookupClient returns Unknown application)", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent" },
          params: { client_id: "", scope: "monize:read" },
        }),
      });
      const req = { cookies: { auth_token: "tok" } } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.send).toHaveBeenCalled();
    });

    it("logs and falls back when Client.find throws", async () => {
      const { controller, provider } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
      });
      provider.Client.find = jest.fn().mockRejectedValue(new Error("db down"));
      const req = { cookies: { auth_token: "tok" } } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.send).toHaveBeenCalled();
    });
  });

  describe("resolveCookieUser branches", () => {
    it("returns null when JWT type is 2fa_pending", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "login" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        jwtVerify: jest
          .fn()
          .mockResolvedValue({ sub: "x", type: "2fa_pending" }),
      });
      const req = { cookies: { auth_token: "tok" }, originalUrl: "/x" } as any;
      const res = makeRes();
      await controller.render(req, res);
      // Falls through to login redirect since user is null
      expect(res.redirect).toHaveBeenCalled();
    });

    it("returns null when user is inactive", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "login" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        findUser: jest.fn().mockResolvedValue({
          id: "u1",
          email: "x",
          isActive: false,
          mustChangePassword: false,
        }),
      });
      const req = {
        cookies: { auth_token: "tok" },
        originalUrl: "/oauth-consent/u1",
      } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.redirect).toHaveBeenCalled();
    });

    it("returns null when user must change password", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "login" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        findUser: jest.fn().mockResolvedValue({
          id: "u1",
          email: "x",
          isActive: true,
          mustChangePassword: true,
        }),
      });
      const req = {
        cookies: { auth_token: "tok" },
        originalUrl: "/oauth-consent/u1",
      } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.redirect).toHaveBeenCalled();
    });

    it("returns null when JWT verification fails", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "login" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        jwtVerify: jest.fn().mockRejectedValue(new Error("invalid")),
      });
      const req = {
        cookies: { auth_token: "tok" },
        originalUrl: "/oauth-consent/u1",
      } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.redirect).toHaveBeenCalled();
    });

    it("returns null when user has no email (uses null)", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        findUser: jest.fn().mockResolvedValue({
          id: "u1",
          email: null,
          isActive: true,
          mustChangePassword: false,
        }),
      });
      const req = { cookies: { auth_token: "tok" } } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.send).toHaveBeenCalled();
    });
  });

  describe("buildLoginRedirect branches", () => {
    it("normalizes returnTo without leading slash", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "login" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        findUser: jest.fn().mockResolvedValue(null),
        publicUrl: "https://example.com/",
      });
      const req = {
        cookies: {},
        originalUrl: undefined,
        url: "no-slash-prefix",
      } as any;
      const res = makeRes();
      await controller.render(req, res);
      const target = (res.redirect as jest.Mock).mock.calls[0][1] as string;
      expect(target).toContain("returnTo=%2Fno-slash-prefix");
    });

    it("uses empty base when PUBLIC_APP_URL not set", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "login" },
          params: { client_id: "claude-desktop", scope: "monize:read" },
        }),
        findUser: jest.fn().mockResolvedValue(null),
        publicUrl: undefined,
      });
      const req = { cookies: {}, originalUrl: "/x" } as any;
      const res = makeRes();
      await controller.render(req, res);
      expect(res.redirect).toHaveBeenCalled();
    });
  });

  describe("confirm branches", () => {
    const consentDetails = {
      missingOIDCScope: ["openid", "monize:read"],
      missingResourceScopes: {
        "https://app.monize.test/api/v1/mcp": ["monize:read"],
      },
    };

    it("reuses the existing grant when the interaction already has a grantId", async () => {
      const existing = {
        addOIDCScope: jest.fn(),
        addOIDCClaims: jest.fn(),
        addResourceScope: jest.fn(),
        save: jest.fn().mockResolvedValue("grant-existing"),
      };
      class GrantMock {
        static find = jest.fn().mockResolvedValue(existing);
      }
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent", details: consentDetails },
          params: { client_id: "claude-desktop" },
          session: { accountId: USER_ID },
          grantId: "g1",
        }),
        Grant: GrantMock as any,
      });
      const req = { cookies: { auth_token: "tok" } } as any;
      const res = makeRes();
      await controller.confirm(req, res);
      expect(GrantMock.find).toHaveBeenCalledWith("g1");
      expect(existing.addOIDCScope).toHaveBeenCalledWith("openid monize:read");
      expect(existing.save).toHaveBeenCalled();
    });

    it("creates a new grant when grantId is set but find returns null", async () => {
      const created = {
        addOIDCScope: jest.fn(),
        addOIDCClaims: jest.fn(),
        addResourceScope: jest.fn(),
        save: jest.fn().mockResolvedValue("grant-new"),
      };
      class GrantMock {
        constructor() {
          return created;
        }
        static find = jest.fn().mockResolvedValue(null);
      }
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u1",
          prompt: { name: "consent", details: consentDetails },
          params: { client_id: "claude-desktop" },
          session: { accountId: USER_ID },
          grantId: "g1",
        }),
        Grant: GrantMock as any,
      });
      const req = { cookies: { auth_token: "tok" } } as any;
      const res = makeRes();
      await controller.confirm(req, res);
      expect(created.save).toHaveBeenCalled();
    });
  });
});
