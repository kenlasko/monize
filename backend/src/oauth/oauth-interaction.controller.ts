import { Controller, Get, Post, Req, Res, Logger } from "@nestjs/common";
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
import { withUserContext } from "../common/db/with-context";
import { SecurityNoticeService } from "../notifications/security-notice.service";

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
    private readonly securityNotices: SecurityNoticeService,
  ) {}

  @Get(":uid")
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async render(@Req() req: Request, @Res() res: Response) {
    const provider = this.providerService.getProvider();
    let interaction;
    try {
      interaction = await provider.interactionDetails(req, res);
    } catch (err) {
      // Stale/consumed/expired interaction (e.g. user clicked back, or
      // the consent was already submitted). Render a friendly page
      // instead of bubbling SessionNotFound up to a 500.
      this.logger.log(
        `interaction.render uid=${req.params?.uid} no live interaction (${(err as Error).name}: ${(err as Error).message}) — rendering closed-window page`,
      );
      this.respondWithStaleInteractionPage(res);
      return;
    }
    const { prompt, params, uid } = interaction;
    if (this.redirectStalePage(req, res, uid, "render")) return;
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
      const clientInfo = await this.lookupClient(params.client_id as string);

      const html = renderConsentPage({
        uid,
        clientName: clientInfo.name,
        clientUri: clientInfo.uri,
        // Where THIS request's code goes: the provider matched it against the
        // client's registered redirect_uris before creating the interaction.
        redirectUri:
          typeof params.redirect_uri === "string" ? params.redirect_uri : null,
        userEmail: user.email ?? user.id,
        scopes: validScopes,
        resource:
          typeof params.resource === "string"
            ? params.resource
            : this.providerService.getMcpResourceUrl(),
      });
      this.setInteractionPageHeaders(res);
      res.send(html);
      return;
    }

    this.logger.warn(`Unknown interaction prompt: ${prompt.name}`);
    res.status(400).send("Unsupported interaction prompt");
  }

  @Post(":uid/confirm")
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async confirm(@Req() req: Request, @Res() res: Response) {
    const provider = this.providerService.getProvider();
    let interaction;
    try {
      interaction = await provider.interactionDetails(req, res);
    } catch (err) {
      // Duplicate / stale form submission (back button, double-click,
      // or claude.ai re-prompting after the first submit had already
      // succeeded). The interaction has been consumed; render a
      // friendly closed-window page instead of a 500.
      this.logger.log(
        `interaction.confirm uid=${req.params?.uid} no live interaction (${(err as Error).name}: ${(err as Error).message}) — rendering closed-window page`,
      );
      this.respondWithStaleInteractionPage(res);
      return;
    }
    if (this.redirectStalePage(req, res, interaction.uid, "confirm")) return;
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

    const clientId = params.client_id as string;

    // node-oidc-provider's consent Check requires the saved Grant to cover
    // EVERY scope and claim the authorization request asked for. If anything
    // stays missing the provider re-prompts, minting a fresh consent
    // interaction on each submit (the "consent uid keeps changing" loop).
    // Claude requests OIDC scopes (openid, profile) alongside the MCP resource
    // scopes (monize:read/write), so grant exactly what the prompt reports as
    // missing rather than only the monize:* subset. Granular per-scope consent
    // is intentionally not offered: the client fixes the requested scope set,
    // and withholding any of it would just loop the prompt — the user's choice
    // is Allow (grant all) or Deny.
    const details = prompt.details as {
      missingOIDCScope?: string[];
      missingOIDCClaims?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };

    const Grant = provider.Grant;
    const found = interaction.grantId
      ? await Grant.find(interaction.grantId)
      : undefined;
    // A looked-up grant is not automatically this user's grant, and the scopes
    // below are about to be added to whatever it is. The session check above
    // guards the interaction; `grantId` is a separate field, and it names a row
    // by opaque id. Adopt it only when it belongs to this account AND this
    // client -- otherwise start a fresh one, which is what an unrelated grantId
    // should have produced in the first place. Defence in depth: the provider is
    // not expected to hand over a foreign grantId, but "it should not happen" is
    // not a check, and the cost of making it one is an `&&`.
    const existing =
      found && found.accountId === user.id && found.clientId === clientId
        ? found
        : undefined;
    if (found && !existing) {
      this.logger.warn(
        `interaction.confirm ignoring grant ${interaction.grantId}: ` +
          `account=${found.accountId} client=${found.clientId} does not match ` +
          `account=${user.id} client=${clientId}`,
      );
    }
    const grant = existing ?? new Grant({ accountId: user.id, clientId });

    if (details.missingOIDCScope?.length) {
      grant.addOIDCScope(details.missingOIDCScope.join(" "));
    }
    if (details.missingOIDCClaims?.length) {
      grant.addOIDCClaims(details.missingOIDCClaims);
    }
    for (const [indicator, scopes] of Object.entries(
      details.missingResourceScopes ?? {},
    )) {
      grant.addResourceScope(indicator, scopes.join(" "));
    }

    const grantId = await grant.save();
    this.logger.log(
      `interaction.confirm grant saved id=${grantId} account=${user.id} client=${clientId} oidcScopes=${(details.missingOIDCScope ?? []).join(",")} resources=${Object.keys(details.missingResourceScopes ?? {}).join(",")}`,
    );

    if (!existing) {
      // A new grant is a new way into the account. The notice never throws.
      try {
        const { name } = await this.lookupClient(clientId);
        await withUserContext(user.id, () =>
          this.securityNotices.oauthClientAuthorized(user.id, {
            grantId,
            clientId,
            clientName: name,
          }),
        );
      } catch (err) {
        this.logger.warn(
          `interaction.confirm security notice failed: ${(err as Error).message}`,
        );
      }
    }

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
    try {
      await provider.interactionFinished(
        req,
        res,
        {
          error: "access_denied",
          error_description: "User denied access",
        },
        { mergeWithLastSubmission: false },
      );
    } catch (err) {
      // Stale uid (back button, retry after the original abort already
      // landed). Render a friendly closed-window page instead of 500.
      this.logger.log(
        `interaction.abort uid=${req.params?.uid} no live interaction (${(err as Error).name}: ${(err as Error).message}) — rendering closed-window page`,
      );
      this.respondWithStaleInteractionPage(res);
    }
  }

  /**
   * The provider resolves the live interaction from the single `_interaction`
   * cookie (pinned to path '/'), never from the page URL -- so when an MCP
   * client fires a second authorization attempt (Claude retries reconnects),
   * the cookie moves to the new attempt while an older consent page may still
   * be on screen. Acting on the cookie's interaction from that stale page
   * would silently complete a DIFFERENT attempt than the one the user
   * reviewed, and the client is usually waiting on the newest attempt anyway.
   * Detect the mismatch and send the browser to the live interaction's own
   * page so the user approves the attempt that can actually finish.
   *
   * Returns true when a redirect was issued (the caller must stop). The uid
   * param is absent only outside the real Express route (unit tests calling
   * the handler directly); the guard is a self-heal, not an auth boundary --
   * the session/account checks below remain the security checks.
   */
  private redirectStalePage(
    req: Request,
    res: Response,
    liveUid: string,
    phase: "render" | "confirm",
  ): boolean {
    const pageUid = req.params?.uid;
    if (!pageUid || pageUid === liveUid) return false;
    this.logger.log(
      `interaction.${phase} page uid=${pageUid} superseded by live interaction ${liveUid} — redirecting to the live consent page`,
    );
    // 303 turns the stale form POST into a GET of the live page (PRG).
    res.redirect(phase === "confirm" ? 303 : 302, this.consentUrlFor(liveUid));
    return true;
  }

  private consentUrlFor(uid: string): string {
    // Absolute URL for the same reverse-proxy reasons as interactions.url in
    // oauth-provider.service.ts (Envoy can rewrite/drop relative redirects).
    const base =
      this.configService.get<string>("PUBLIC_APP_URL")?.replace(/\/$/, "") ??
      "";
    return `${base}/api/v1/oauth-consent/${encodeURIComponent(uid)}`;
  }

  /**
   * Headers for the HTML pages this controller serves. The Content-Security-
   * Policy REPLACES the app-wide Helmet policy on these responses, and it must:
   * Helmet's defaults (merged under the global config) include
   * `form-action 'self'`, and Chrome enforces form-action against EVERY hop of
   * the redirect chain that follows a form submission. The Allow/Deny POST is
   * answered with a 303 to the provider's /oauth/auth resume endpoint (self),
   * which 303s again to the OAuth client's redirect_uri (cross-origin, e.g.
   * claude.ai) carrying the authorization code. Under `form-action 'self'`
   * Chrome silently cancels that final hop: the server logs
   * authorization.success, the browser stays parked on the consent form, and
   * the client never receives its code -- the connection "never completes"
   * with nothing visibly wrong. So this page's policy allows the chain to end
   * at any https origin (the redirect_uri is per-client and dynamic, so it
   * cannot be enumerated statically); everything else stays locked down.
   */
  private setInteractionPageHeaders(res: Response): void {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
        "style-src 'unsafe-inline'; form-action 'self' https:",
    );
  }

  /**
   * Rendered when the page's interaction no longer exists. That covers both a
   * harmless duplicate submit after a success AND a superseded/expired attempt
   * whose client is still waiting -- the copy must not claim success, or the
   * waiting case reads as done and the user never retries (the connection then
   * "never completes"). Say what is knowable and give the retry path.
   */
  private respondWithStaleInteractionPage(res: Response): void {
    this.setInteractionPageHeaders(res);
    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Authorization window closed — Monize</title>
<style>
  :root {
    --bg: #f8fafc; --card: #ffffff; --text: #0f172a;
    --muted: #64748b; --border: #e2e8f0; --primary: #0284c7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a; --card: #1f2937; --text: #f3f4f6;
      --muted: #9ca3af; --border: #374151; --primary: #38bdf8;
    }
  }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--bg); color: var(--text); padding: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); width: 100%; max-width: 460px;
    padding: 32px; text-align: center; }
  .brand { color: var(--primary); font-weight: 600; font-size: 14px; margin-bottom: 12px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">Monize</div>
    <h1>This authorization window is no longer active</h1>
    <p>The sign-in attempt this window belonged to has already finished or expired.</p>
    <p style="margin-top:12px">If the application that requested access now shows Monize as connected, you are done — close this window. If it is still waiting, close this window and start the connection again from that application; a fresh approval prompt will appear.</p>
  </main>
</body>
</html>`);
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
      // RLS: the OAuth consent pages authenticate from the auth_token cookie,
      // not a Nest req.user -- the verified token's `sub` is the user, so read
      // its own row under a user context (self-policy), no bypass.
      const user = await withUserContext(payload.sub, () =>
        this.authService.getUserById(payload.sub),
      );
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
}
