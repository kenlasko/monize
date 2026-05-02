import { OAuthInteractionController } from "./oauth-interaction.controller";

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
        jest.fn().mockResolvedValue({ sub: "user-1", type: undefined }),
    } as any;
    const authService = {
      getUserById:
        overrides.findUser ??
        jest.fn().mockResolvedValue({
          id: "user-1",
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
        { login: { accountId: "user-1" } },
        { mergeWithLastSubmission: false },
      );
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
        expect.stringContaining('value="monize:read"'),
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
    it("returns 401 when user not authenticated", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "consent" },
          params: { client_id: "c", scope: "monize:read" },
        }),
        jwtVerify: jest.fn().mockRejectedValue(new Error("invalid")),
      });
      const req = { cookies: {}, body: { scopes: ["monize:read"] } } as any;
      const res = makeRes();

      await controller.confirm(req, res, { scopes: ["monize:read"] });

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

      await controller.confirm(req, res, {});

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("rejects when no requested scope is granted", async () => {
      const { controller } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "consent" },
          params: { client_id: "c", scope: "monize:read" },
        }),
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res, { scopes: [] });

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("creates a grant and finishes the interaction with the granted scopes", async () => {
      const { controller, interactionFinished } = makeController({
        interactionDetails: jest.fn().mockResolvedValue({
          uid: "u",
          prompt: { name: "consent" },
          params: {
            client_id: "claude-desktop",
            scope: "monize:read monize:write",
            resource: "https://app.monize.test/api/v1/mcp",
          },
          session: { accountId: "user-1" },
        }),
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res, { scopes: ["monize:read"] });

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
          prompt: { name: "consent" },
          params: { client_id: "c", scope: "monize:read" },
          session: { accountId: "other-user" },
        }),
      });
      const req = { cookies: { auth_token: "v" }, body: {} } as any;
      const res = makeRes();

      await controller.confirm(req, res, { scopes: ["monize:read"] });

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
  });
});
