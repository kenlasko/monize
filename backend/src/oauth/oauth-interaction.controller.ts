import { Controller, Get, Post, Req, Res, Body, Logger } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import {
  OAuthProviderService,
  MCP_RESOURCE_SCOPES,
} from "./oauth-provider.service";
import { renderConsentPage } from "./consent-template";
import { AuthService } from "../auth/auth.service";

interface InteractionFormBody {
  scopes?: string | string[];
}

/**
 * Hosts the user-facing OAuth interaction routes (login + consent) for the
 * MCP remote-connector flow. Routes are mounted at the application root
 * (excluded from the /api/v1 prefix) so they match the issuer URL that the
 * OIDC provider advertises in its discovery metadata.
 */
@ApiExcludeController()
@SkipCsrf()
@Controller("oauth-consent")
export class OAuthInteractionController {
  private readonly logger = new Logger(OAuthInteractionController.name);

  constructor(
    private readonly providerService: OAuthProviderService,
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Get(":uid")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async render(@Req() req: Request, @Res() res: Response) {
    const provider = this.providerService.getProvider();
    const interaction = await provider.interactionDetails(req, res);
    const { prompt, params, uid } = interaction;
    this.logger.log(
      `interaction.render uid=${uid} prompt=${prompt.name} client=${params.client_id} scope="${params.scope}"`,
    );

    if (prompt.name === "login") {
      const user = await this.resolveCookieUser(req);
      if (!user) {
        const loginUrl = this.buildLoginRedirect(req.originalUrl || req.url);
        this.logger.log(
          `interaction.render uid=${uid} -> redirect to login (no auth_token cookie)`,
        );
        res.redirect(302, loginUrl);
        return;
      }
      this.logger.log(
        `interaction.render uid=${uid} -> finishing login for account=${user.id}`,
      );
      await provider.interactionFinished(
        req,
        res,
        { login: { accountId: user.id } },
        { mergeWithLastSubmission: false },
      );
      return;
    }

    if (prompt.name === "consent") {
      const user = await this.resolveCookieUser(req);
      if (!user) {
        // Lost session mid-flow — bounce back through login.
        const loginUrl = this.buildLoginRedirect(req.originalUrl || req.url);
        this.logger.log(
          `interaction.render uid=${uid} consent prompt with no cookie -> back to login`,
        );
        res.redirect(302, loginUrl);
        return;
      }
      this.logger.log(
        `interaction.render uid=${uid} -> rendering consent for account=${user.id}`,
      );

      const requestedScopes =
        (params.scope as string | undefined)?.split(" ") ?? [];
      const validScopes = requestedScopes.filter((s) =>
        (MCP_RESOURCE_SCOPES as readonly string[]).includes(s),
      );

      // Look up the registered client so we can display its human-readable
      // name (e.g. "Claude") instead of the opaque DCR-generated client_id.
      // The auth request params only carry client_id; client_name lives on
      // the persisted client record from the Dynamic Client Registration.
      const clientInfo = await this.lookupClient(
        params.client_id as string,
      );

      const html = renderConsentPage({
        uid,
        clientName: clientInfo.name,
        clientUri: clientInfo.uri,
        userEmail: user.email ?? user.id,
        scopes: validScopes,
        resource:
          typeof params.resource === "string"
            ? params.resource
            : this.providerService.getMcpResourceUrl(),
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(html);
      return;
    }

    this.logger.warn(`Unknown interaction prompt: ${prompt.name}`);
    res.status(400).send("Unsupported interaction prompt");
  }

  @Post(":uid/confirm")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async confirm(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: InteractionFormBody,
  ) {
    const provider = this.providerService.getProvider();
    const interaction = await provider.interactionDetails(req, res);
    const { prompt, params, session } = interaction;

    if (prompt.name !== "consent") {
      res.status(400).send("Interaction is not awaiting consent");
      return;
    }

    const user = await this.resolveCookieUser(req);
    if (!user) {
      res.status(401).send("Login required");
      return;
    }
    if (session?.accountId && session.accountId !== user.id) {
      // Defense in depth: don't allow user A to confirm user B's interaction.
      res.status(403).send("Session does not match interaction");
      return;
    }

    const requestedScopes =
      (params.scope as string | undefined)?.split(" ") ?? [];
    const submittedScopes = this.normalizeScopes(body?.scopes);
    const grantedScopes = requestedScopes.filter(
      (s) =>
        (MCP_RESOURCE_SCOPES as readonly string[]).includes(s) &&
        submittedScopes.includes(s),
    );
    if (grantedScopes.length === 0) {
      res.status(400).send("At least one scope must be granted");
      return;
    }

    const clientId = params.client_id as string;
    const resource =
      (params.resource as string | undefined) ??
      this.providerService.getMcpResourceUrl();

    const Grant = provider.Grant;
    let grant: InstanceType<typeof Grant>;
    if (interaction.grantId) {
      const existing = await Grant.find(interaction.grantId);
      grant = existing ?? new Grant({ accountId: user.id, clientId });
    } else {
      grant = new Grant({ accountId: user.id, clientId });
    }

    grant.addOIDCScope(grantedScopes.join(" "));
    grant.addResourceScope(resource, grantedScopes.join(" "));
    const grantId = await grant.save();
    this.logger.log(
      `interaction.confirm grant saved id=${grantId} account=${user.id} client=${clientId} scopes=${grantedScopes.join(",")}`,
    );

    await provider.interactionFinished(
      req,
      res,
      { consent: { grantId } },
      { mergeWithLastSubmission: true },
    );
  }

  @Post(":uid/abort")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async abort(@Req() req: Request, @Res() res: Response) {
    const provider = this.providerService.getProvider();
    await provider.interactionFinished(
      req,
      res,
      {
        error: "access_denied",
        error_description: "User denied access",
      },
      { mergeWithLastSubmission: false },
    );
  }

  private async resolveCookieUser(
    req: Request,
  ): Promise<{ id: string; email: string | null } | null> {
    const token = req.cookies?.["auth_token"];
    if (!token) return null;
    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        type?: string;
      }>(token);
      if (payload.type === "2fa_pending") return null;
      const user = await this.authService.getUserById(payload.sub);
      if (!user || !user.isActive || user.mustChangePassword) return null;
      return { id: user.id, email: user.email ?? null };
    } catch {
      return null;
    }
  }

  private buildLoginRedirect(returnTo: string): string {
    const base =
      this.configService.get<string>("PUBLIC_APP_URL")?.replace(/\/$/, "") ??
      "";
    const safeReturn = returnTo.startsWith("/") ? returnTo : `/${returnTo}`;
    const params = new URLSearchParams({ returnTo: safeReturn });
    return `${base}/login?${params.toString()}`;
  }

  private async lookupClient(
    clientId: string,
  ): Promise<{ name: string; uri: string | null }> {
    if (!clientId) {
      return { name: "Unknown application", uri: null };
    }
    try {
      const provider = this.providerService.getProvider();
      const client = await provider.Client.find(clientId);
      const name =
        (client && typeof client.clientName === "string"
          ? client.clientName
          : null) || clientId;
      const uri =
        client && typeof client.clientUri === "string"
          ? client.clientUri
          : null;
      return { name, uri };
    } catch (err) {
      this.logger.warn(
        `lookupClient failed for ${clientId}: ${(err as Error).message}`,
      );
      return { name: clientId, uri: null };
    }
  }

  private normalizeScopes(input: string | string[] | undefined): string[] {
    if (!input) return [];
    return Array.isArray(input) ? input : [input];
  }
}
