import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Delete,
  Param,
  Request,
  Res,
  Query,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  Logger,
  ParseUUIDPipe,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { rateLimit } from "../common/throttle.util";
import { Response, Request as ExpressRequest } from "express";

import { AuthService } from "./auth.service";
import { TokenService } from "./token.service";
import { OidcService } from "./oidc/oidc.service";
import { EmailService } from "../notifications/email.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { ResendVerificationDto } from "./dto/resend-verification.dto";
import { VerifyTotpDto } from "./dto/verify-totp.dto";
import { Setup2faDto } from "./dto/setup-2fa.dto";
import { Setup2faInitDto } from "./dto/setup-2fa-init.dto";
import {
  passwordResetTemplate,
  emailVerificationTemplate,
} from "../notifications/email-templates";
import { SwitchContextDto } from "./dto/switch-context.dto";
import { I18nService } from "nestjs-i18n";
import { emailTranslator } from "../i18n/email-translator";
import { DEFAULT_LOCALE } from "../i18n/config";
import { DelegationService } from "../delegation/delegation.service";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import { SkipPasswordCheck } from "./decorators/skip-password-check.decorator";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { DemoModeService } from "../common/demo-mode.service";
import { generateCsrfToken, getCsrfCookieOptions } from "../common/csrf.util";
import { encrypt, decrypt, derivePurposeKey } from "./crypto.util";
import { tr } from "../i18n/translate";

@ApiTags("Authentication")
@Controller("auth")
@SkipPasswordCheck()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private localAuthEnabled: boolean;
  private registrationEnabled: boolean;
  private force2fa: boolean;
  private useSecureCookies: boolean;
  private trustedDeviceCookieKey: string;

  constructor(
    private authService: AuthService,
    private oidcService: OidcService,
    private configService: ConfigService,
    private emailService: EmailService,
    private demoModeService: DemoModeService,
    private tokenService: TokenService,
    private delegationService: DelegationService,
    private readonly i18n: I18nService,
  ) {
    // Default to true if not explicitly set to 'false'
    const localAuthSetting = this.configService.get<string>(
      "LOCAL_AUTH_ENABLED",
      "true",
    );
    this.localAuthEnabled = localAuthSetting.toLowerCase() !== "false";
    const registrationSetting = this.configService.get<string>(
      "REGISTRATION_ENABLED",
      "true",
    );
    this.registrationEnabled = registrationSetting.toLowerCase() !== "false";
    const force2faSetting = this.configService.get<string>(
      "FORCE_2FA",
      "false",
    );
    this.force2fa = force2faSetting.toLowerCase() === "true";
    const disableHttpsHeaders =
      this.configService
        .get<string>("DISABLE_HTTPS_HEADERS", "false")
        .toLowerCase() === "true";
    this.useSecureCookies =
      this.configService.get<string>("NODE_ENV") === "production" &&
      !disableHttpsHeaders;

    // Purpose-derived key for encrypting the trusted-device cookie value
    // (CWE-312). The cookie carries the AES-256-GCM ciphertext of the
    // trusted-device reference; the server decrypts on each login before
    // using the value to look up the device record (by hash) in the DB.
    const jwtSecret = this.configService.get<string>("JWT_SECRET")!;
    this.trustedDeviceCookieKey = derivePurposeKey(
      jwtSecret,
      "trusted-device-cookie",
    );
  }

  private encryptTrustedDeviceCookie(ref: string): string {
    return encrypt(ref, this.trustedDeviceCookieKey);
  }

  private decryptTrustedDeviceCookie(
    encryptedValue: string | undefined,
  ): string | undefined {
    if (!encryptedValue) return undefined;
    try {
      return decrypt(encryptedValue, this.trustedDeviceCookieKey);
    } catch {
      // Malformed or legacy unencrypted cookie: treat as absent and force
      // the user through the normal 2FA flow on this login.
      return undefined;
    }
  }

  /**
   * Decide whether the OIDC provider actually performed multi-factor auth.
   * Matches RFC 8176 "amr" values that imply a second factor, plus a small
   * set of well-known multi-factor "acr" strings. When neither claim is
   * present we treat it as "MFA not proven".
   */
  private oidcProvedMfa(amr: string[] | undefined, acr: string | undefined) {
    const mfaAmrValues = new Set([
      "mfa",
      "otp",
      "totp",
      "hwk",
      "swk",
      "sms",
      "tel",
      "pop",
      "fpt",
      "face",
      "iris",
      "retina",
      "vbm",
      "wia",
      "kba",
    ]);
    if (amr?.some((v) => mfaAmrValues.has(v.toLowerCase()))) {
      // "pwd" + a second factor is the normal case; the presence of any
      // second-factor value on top of the password is enough.
      return true;
    }
    if (acr) {
      const lower = acr.toLowerCase();
      if (
        lower.includes("mfa") ||
        lower.endsWith(":2") ||
        lower.endsWith("/2") ||
        lower === "2" ||
        /loa[-_]?[234]/.test(lower)
      ) {
        return true;
      }
    }
    return false;
  }

  private getAccessCookieOptions() {
    return {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
      maxAge: 15 * 60 * 1000, // 15 minutes (matches JWT expiry)
      path: "/",
    };
  }

  private getRefreshCookieOptions(rememberMe?: boolean) {
    return {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "strict" as const,
      maxAge: this.tokenService.getRefreshExpiryMs(rememberMe),
      path: "/",
    };
  }

  private setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
    userId: string,
    rememberMe?: boolean,
  ) {
    res.cookie("auth_token", accessToken, this.getAccessCookieOptions());
    res.cookie(
      "refresh_token",
      refreshToken,
      this.getRefreshCookieOptions(rememberMe),
    );
    res.cookie(
      "csrf_token",
      generateCsrfToken(userId, this.authService.getCsrfKey()),
      getCsrfCookieOptions(this.useSecureCookies),
    );
  }

  private clearAuthCookies(res: Response) {
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
      path: "/",
    });
    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "strict" as const,
      path: "/",
    });
    res.clearCookie("csrf_token", {
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
      path: "/",
    });
  }

  @Post("register")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } }) // 5 attempts per 15 minutes
  @ApiOperation({ summary: "Register a new user with local credentials" })
  @ApiResponse({ status: 403, description: "Local authentication is disabled" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async register(@Body() registerDto: RegisterDto, @Res() res: Response) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException(
        tr(
          "errors.auth.localAuthDisabled",
          "Local authentication is disabled. Please use OIDC to sign in.",
        ),
      );
    }
    if (!this.registrationEnabled) {
      throw new ForbiddenException(
        tr(
          "errors.auth.registrationDisabled",
          "New account registration is disabled.",
        ),
      );
    }
    const result = await this.authService.register(registerDto);

    // When email verification is required the account exists but cannot sign
    // in yet, so no auth cookies are set. Send the verification link and tell
    // the client to show its "check your email" state.
    if (result.verificationRequired) {
      await this.sendVerificationEmail(
        result.user.email!,
        result.user.firstName ?? "",
        result.verificationToken,
      );
      return res.json({ verificationRequired: true });
    }

    this.setAuthCookies(
      res,
      result.accessToken!,
      result.refreshToken!,
      result.user!.id,
    );
    res.json({ user: result.user });
  }

  /**
   * Build the verification link and email it. Shared by registration and the
   * resend endpoint. Failures are logged, never thrown, so the HTTP response
   * does not reveal whether delivery succeeded (mirrors password-reset).
   */
  private async sendVerificationEmail(
    email: string,
    firstName: string,
    token: string,
  ): Promise<void> {
    const frontendUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );
    const verifyUrl = `${frontendUrl}/verify-email?token=${token}`;
    const lang = DEFAULT_LOCALE;
    const t = emailTranslator(this.i18n, lang);
    const html = emailVerificationTemplate(firstName, verifyUrl, t);

    try {
      await this.emailService.sendMail(
        email,
        t("emails.emailVerification.subject", "Verify your Monize email"),
        html,
      );
    } catch (error) {
      this.logger.error(
        "Failed to send email verification email",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  @Post("login")
  @AllowDelegate()
  @SkipCsrf()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } }) // 5 attempts per 15 minutes
  @ApiOperation({ summary: "Login with local credentials" })
  @ApiResponse({ status: 403, description: "Local authentication is disabled" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async login(
    @Body() loginDto: LoginDto,
    @Request() req: ExpressRequest,
    @Res() res: Response,
  ) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException(
        tr(
          "errors.auth.localAuthDisabled",
          "Local authentication is disabled. Please use OIDC to sign in.",
        ),
      );
    }
    const trustedDeviceRef = this.decryptTrustedDeviceCookie(
      req.cookies?.["trusted_device"],
    );
    const userAgent = req.headers?.["user-agent"];
    const result = await this.authService.login(
      loginDto,
      trustedDeviceRef,
      userAgent,
    );

    // If 2FA is required, return temp token without setting cookie
    if (result.requires2FA) {
      return res.json({ requires2FA: true, tempToken: result.tempToken });
    }

    // Email not verified yet: no cookies, tell the client to prompt a resend.
    if (result.emailNotVerified) {
      return res.json({ emailNotVerified: true });
    }

    this.setAuthCookies(
      res,
      result.accessToken!,
      result.refreshToken!,
      result.user!.id,
      result.rememberMe,
    );
    res.json({ user: result.user });
  }

  @Get("oidc")
  @AllowDelegate()
  @ApiOperation({ summary: "Initiate OIDC authentication" })
  @ApiResponse({ status: 302, description: "Redirects to OIDC provider" })
  @ApiResponse({ status: 400, description: "OIDC not configured" })
  async oidcLogin(@Res() res: Response) {
    if (!this.oidcService.enabled) {
      throw new BadRequestException(
        tr(
          "errors.auth.oidcNotConfigured",
          "OIDC authentication is not configured",
        ),
      );
    }

    const state = this.oidcService.generateState();
    const nonce = this.oidcService.generateNonce();

    // Store state/nonce in secure cookies for validation
    const cookieOptions = {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
      maxAge: 600000, // 10 minutes
    };

    res.cookie("oidc_state", state, cookieOptions);
    res.cookie("oidc_nonce", nonce, cookieOptions);

    const authUrl = this.oidcService.getAuthorizationUrl(state, nonce);
    res.redirect(authUrl);
  }

  @Get("oidc/callback")
  @AllowDelegate()
  @ApiOperation({ summary: "OIDC callback handler" })
  async oidcCallback(
    @Query() query: Record<string, string>,
    @Request() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const frontendUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    const clearOidcCookieOptions = {
      httpOnly: true,
      secure: this.useSecureCookies,
      sameSite: "lax" as const,
    };

    try {
      // Check for OIDC provider error response before processing
      if (query.error) {
        this.logger.warn(
          `OIDC provider returned error: ${query.error} - ${query.error_description || "no description"}`,
        );
        throw new Error(`OIDC provider error: ${query.error}`);
      }

      const state = req.cookies?.["oidc_state"];
      const nonce = req.cookies?.["oidc_nonce"];

      // Clear OIDC cookies with matching options
      res.clearCookie("oidc_state", clearOidcCookieOptions);
      res.clearCookie("oidc_nonce", clearOidcCookieOptions);

      if (!state || !nonce) {
        throw new Error(
          "Missing OIDC state or nonce - session may have expired",
        );
      }

      // Handle callback with OIDC provider
      const tokenSet = await this.oidcService.handleCallback(
        query,
        state,
        nonce,
      );

      // SECURITY: When FORCE_2FA is enabled, app-level 2FA is unavailable for
      // OIDC users (2FA is delegated to the identity provider). To still
      // honor the admin's "require MFA for everyone" intent, require the IdP
      // to assert MFA via RFC 8176 "amr" or a multi-factor "acr" value.
      if (this.force2fa && !this.oidcProvedMfa(tokenSet.amr, tokenSet.acr)) {
        this.logger.warn(
          `OIDC login rejected: FORCE_2FA is enabled but IdP did not assert MFA (amr=${JSON.stringify(tokenSet.amr)}, acr=${tokenSet.acr})`,
        );
        res.redirect(`${frontendUrl}/auth/callback?error=mfa_required`);
        return;
      }

      // Get user info from OIDC provider
      const userInfo = await this.oidcService.getUserInfo(
        tokenSet.access_token,
        tokenSet.sub,
      );

      // Find or create user
      const result = await this.authService.findOrCreateOidcUser(
        userInfo,
        this.registrationEnabled,
      );

      // SECURITY: If an existing local account needs confirmation before linking,
      // do NOT issue tokens. Redirect with a message instead.
      if (result.linkPending) {
        res.redirect(`${frontendUrl}/auth/callback?link=pending`);
        return;
      }

      // Generate token pair
      const { accessToken, refreshToken } =
        await this.authService.generateTokenPair(result.user);

      this.setAuthCookies(res, accessToken, refreshToken, result.user.id);
      res.redirect(`${frontendUrl}/auth/callback?success=true`);
    } catch (error) {
      // Clear OIDC cookies on error path as well
      res.clearCookie("oidc_state", clearOidcCookieOptions);
      res.clearCookie("oidc_nonce", clearOidcCookieOptions);
      // SECURITY: Log detailed error server-side only, don't expose to client
      this.logger.error(
        "OIDC callback error",
        error instanceof Error ? error.stack : undefined,
      );
      // Return generic error message to prevent information disclosure
      res.redirect(`${frontendUrl}/auth/callback?error=authentication_failed`);
    }
  }

  @Get("oidc/status")
  @AllowDelegate()
  @ApiOperation({ summary: "Check if OIDC is enabled" })
  @ApiResponse({ status: 200, description: "Returns OIDC enabled status" })
  async oidcStatus() {
    return { enabled: this.oidcService.enabled };
  }

  @Get("methods")
  @AllowDelegate()
  @ApiOperation({ summary: "Get available authentication methods" })
  @ApiResponse({
    status: 200,
    description: "Returns available authentication methods",
  })
  async getAuthMethods() {
    return {
      local: this.localAuthEnabled,
      oidc: this.oidcService.enabled,
      registration: this.demoModeService.isDemo
        ? false
        : this.registrationEnabled,
      smtp: this.emailService.getStatus().configured,
      force2fa: this.demoModeService.isDemo ? false : this.force2fa,
      demo: this.demoModeService.isDemo,
    };
  }

  @Get("csrf-refresh")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Refresh CSRF token cookie" })
  async csrfRefresh(@Request() req, @Res() res: Response) {
    res.cookie(
      "csrf_token",
      generateCsrfToken(req.user.id, this.authService.getCsrfKey()),
      getCsrfCookieOptions(this.useSecureCookies),
    );
    res.json({ message: "CSRF token refreshed" });
  }

  @Get("profile")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current user profile" })
  async getProfile(@Request() req) {
    return this.authService.sanitizeUser(req.user);
  }

  @Get("me-self")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Authenticated user's OWN profile (delegate id, never the owner). " +
      "Used by Security settings while acting as a delegate.",
  })
  async getSelfProfile(@Request() req) {
    const user = await this.authService.getUserById(req.user.realUserId);
    if (!user) return null;
    return this.authService.sanitizeUser(user);
  }

  @Get("contexts")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "List delegate contexts and the current acting context",
  })
  async getContexts(@Request() req) {
    return {
      actingAsUserId: req.user.isActing ? req.user.id : null,
      contexts: await this.delegationService.getAvailableContexts(
        req.user.realUserId,
      ),
      capabilities:
        req.user.isActing && req.user.delegationId
          ? await this.delegationService.getCapabilities(req.user.delegationId)
          : null,
      sections:
        req.user.isActing && req.user.delegationId
          ? {
              ...(await this.delegationService.getSections(
                req.user.delegationId,
              )),
              // Not a stored section: derived from per-account grants so the
              // delegate's Transactions nav appears when they can read any
              // non-investment account.
              transactions: await this.delegationService.hasTransactionalAccess(
                req.user.delegationId,
              ),
              // Likewise derived: the Accounts nav appears as soon as the
              // delegate can read any one of the owner's accounts.
              accounts: await this.delegationService.hasAnyAccountAccess(
                req.user.delegationId,
              ),
            }
          : null,
    };
  }

  @Post("switch-context")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Switch the acting account without re-login (delegate)",
  })
  async switchContext(
    @Request() req: ExpressRequest & { user: any },
    @Body() dto: SwitchContextDto,
    @Res() res: Response,
  ) {
    const realUserId = req.user.realUserId;
    const target = await this.delegationService.resolveSwitchTarget(
      realUserId,
      dto.targetUserId,
    );

    const realUser = await this.authService.getUserById(realUserId);
    if (!realUser || !realUser.isActive) {
      throw new UnauthorizedException(
        tr("errors.auth.userNotFoundOrInactive", "User not found or inactive"),
      );
    }

    // SECURITY: revoke the current refresh family so a stale refresh token
    // cannot silently restore the previous context.
    const currentRefresh = req.cookies?.["refresh_token"];
    if (currentRefresh) {
      await this.authService.revokeRefreshToken(currentRefresh);
    }

    const context = target
      ? { actingAsUserId: target.ownerUserId, delegationId: target.id }
      : undefined;

    const { accessToken, refreshToken } =
      await this.tokenService.generateTokenPair(realUser, false, context);

    this.setAuthCookies(res, accessToken, refreshToken, realUser.id);
    res.json({ actingAsUserId: target ? target.ownerUserId : null });
  }

  @Post("forgot-password")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(3) } })
  @ApiOperation({ summary: "Request password reset email" })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException(
        tr(
          "errors.auth.localAuthDisabledShort",
          "Local authentication is disabled.",
        ),
      );
    }

    // M7: Per-email rate limiting (max 3 per email per hour)
    if (!this.authService.checkForgotPasswordEmailLimit(dto.email)) {
      // SECURITY: Still return success to prevent account enumeration
      return {
        message:
          "If an account exists with that email, a password reset link has been sent.",
      };
    }

    const result = await this.authService.generateResetToken(dto.email);

    if (result && this.emailService.getStatus().configured) {
      const frontendUrl = this.configService.get<string>(
        "PUBLIC_APP_URL",
        "http://localhost:3000",
      );
      const resetUrl = `${frontendUrl}/reset-password?token=${result.token}`;
      const lang = DEFAULT_LOCALE;
      const t = emailTranslator(this.i18n, lang);
      const html = passwordResetTemplate(
        result.user.firstName || "",
        resetUrl,
        t,
      );

      try {
        await this.emailService.sendMail(
          result.user.email!,
          t("emails.passwordReset.subject", "Monize Password Reset"),
          html,
        );
      } catch (error) {
        this.logger.error(
          "Failed to send password reset email",
          error instanceof Error ? error.stack : error,
        );
      }
    }

    // SECURITY: Always return success to prevent account enumeration
    return {
      message:
        "If an account exists with that email, a password reset link has been sent.",
    };
  }

  @Post("reset-password")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiOperation({ summary: "Reset password using token" })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return { message: "Password reset successfully. You can now log in." };
  }

  @Post("verify-email")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiOperation({ summary: "Verify a new account's email address" })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto.token);
    return { message: "Email verified successfully. You can now log in." };
  }

  @Post("resend-verification")
  @AllowDelegate()
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(3) } })
  @ApiOperation({ summary: "Resend the email verification link" })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException(
        tr(
          "errors.auth.localAuthDisabledShort",
          "Local authentication is disabled.",
        ),
      );
    }

    // SECURITY: Always return the same generic response so the endpoint never
    // reveals whether an account exists or is already verified.
    const genericResponse = {
      message:
        "If an account exists with that email and still needs verification, " +
        "a new verification link has been sent.",
    };

    // Per-email rate limiting (max 3 per email per hour)
    if (!this.authService.checkVerificationEmailLimit(dto.email)) {
      return genericResponse;
    }

    if (this.emailService.getStatus().configured) {
      const result = await this.authService.generateVerificationToken(
        dto.email,
      );
      if (result) {
        await this.sendVerificationEmail(
          result.user.email!,
          result.user.firstName ?? "",
          result.token,
        );
      }
    }

    return genericResponse;
  }

  @Post("2fa/verify")
  @AllowDelegate()
  @SkipCsrf()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiOperation({ summary: "Verify TOTP code to complete 2FA login" })
  async verify2FA(
    @Body() dto: VerifyTotpDto,
    @Request() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const userAgent = req.headers["user-agent"] || "Unknown Device";
    const rawIp = req.ip || req.socket?.remoteAddress;
    const ipAddress = rawIp?.replace(/^::ffff:/, "");
    const result = await this.authService.verify2FA(
      dto.tempToken,
      dto.code,
      dto.rememberDevice || false,
      userAgent,
      ipAddress,
    );

    this.setAuthCookies(
      res,
      result.accessToken,
      result.refreshToken,
      result.user.id,
      result.rememberMe,
    );

    if (result.trustedDeviceRef) {
      // The trusted-device reference is a 64-byte random opaque identifier
      // (see TwoFactorService.createTrustedDevice). Before placing it in the
      // cookie we AES-256-GCM-encrypt it with a purpose-derived key, so the
      // cookie carries only ciphertext (CWE-312). The server decrypts on
      // each login to recover the reference, then looks up the stored
      // SHA-256 hash in the DB. The cookie is httpOnly, Secure (in
      // production), SameSite=Lax, and expires after 14 days.
      const encryptedCookie = this.encryptTrustedDeviceCookie(
        result.trustedDeviceRef,
      );
      res.cookie("trusted_device", encryptedCookie, {
        httpOnly: true,
        secure: this.useSecureCookies,
        sameSite: "lax",
        maxAge: 14 * 24 * 60 * 60 * 1000, // M5: 14 days (reduced from 30)
      });
    }

    res.json({ user: result.user });
  }

  @Post("2fa/setup")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Generate QR code and secret for 2FA setup" })
  async setup2FA(@Request() req, @Body() dto: Setup2faInitDto) {
    return this.authService.setup2FA(req.user.realUserId, dto.currentPassword);
  }

  @Post("2fa/confirm-setup")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Confirm 2FA setup with verification code" })
  async confirmSetup2FA(@Request() req, @Body() dto: Setup2faDto) {
    return this.authService.confirmSetup2FA(req.user.realUserId, dto.code);
  }

  @Post("2fa/disable")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Disable 2FA with verification code" })
  async disable2FA(@Request() req, @Body() dto: Setup2faDto) {
    return this.authService.disable2FA(req.user.realUserId, dto.code);
  }

  @Get("2fa/status")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Whether 2FA is enabled for the authenticated user (self).",
  })
  async get2FAStatus(@Request() req) {
    const enabled = await this.authService.is2FAEnabled(req.user.realUserId);
    return { enabled };
  }

  @Get("2fa/trusted-devices")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({ summary: "List trusted devices for the current user" })
  async getTrustedDevices(
    @Request() req: ExpressRequest & { user: any },
    @Res() res: Response,
  ) {
    const devices = await this.authService.getTrustedDevices(
      req.user.realUserId,
    );
    const currentToken = req.cookies?.["trusted_device"];
    let currentDeviceId: string | null = null;
    if (currentToken) {
      currentDeviceId = await this.authService.findTrustedDeviceByToken(
        req.user.realUserId,
        currentToken,
      );
    }
    const result = devices.map((d) => ({
      id: d.id,
      deviceName: d.deviceName,
      ipAddress: d.ipAddress,
      lastUsedAt: d.lastUsedAt,
      expiresAt: d.expiresAt,
      createdAt: d.createdAt,
      isCurrent: d.id === currentDeviceId,
    }));
    res.json(result);
  }

  @Delete("2fa/trusted-devices/:id")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a specific trusted device" })
  async revokeTrustedDevice(
    @Request() req: ExpressRequest & { user: any },
    @Param("id", ParseUUIDPipe) deviceId: string,
    @Res() res: Response,
  ) {
    await this.authService.revokeTrustedDevice(req.user.realUserId, deviceId);
    // If revoking the current device, clear the cookie
    const currentToken = req.cookies?.["trusted_device"];
    if (currentToken) {
      const currentDeviceId = await this.authService.findTrustedDeviceByToken(
        req.user.realUserId,
        currentToken,
      );
      if (!currentDeviceId || currentDeviceId === deviceId) {
        res.clearCookie("trusted_device");
      }
    }
    res.json({ message: "Device revoked successfully" });
  }

  @Delete("2fa/trusted-devices")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke all trusted devices" })
  async revokeAllTrustedDevices(
    @Request() req: ExpressRequest & { user: any },
    @Res() res: Response,
  ) {
    const count = await this.authService.revokeAllTrustedDevices(
      req.user.realUserId,
    );
    res.clearCookie("trusted_device");
    res.json({ message: `${count} device(s) revoked`, count });
  }

  @Post("refresh")
  @AllowDelegate()
  @SkipCsrf()
  @Throttle({ default: { ttl: 60000, limit: rateLimit(10) } }) // 10 refreshes per minute
  @ApiOperation({ summary: "Refresh access token using refresh token cookie" })
  async refresh(@Request() req: ExpressRequest, @Res() res: Response) {
    const refreshToken = req.cookies?.["refresh_token"];
    if (!refreshToken) {
      throw new UnauthorizedException(
        tr("errors.auth.noRefreshTokenProvided", "No refresh token provided"),
      );
    }

    try {
      const result = await this.authService.refreshTokens(refreshToken);
      this.setAuthCookies(
        res,
        result.accessToken,
        result.refreshToken,
        result.userId,
      );
      res.json({ message: "Token refreshed" });
    } catch (error) {
      this.clearAuthCookies(res);
      throw error;
    }
  }

  @Post("2fa/backup-codes")
  @UseGuards(AuthGuard("jwt"))
  @AllowDelegate()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: rateLimit(5) } })
  @ApiBearerAuth()
  @ApiOperation({ summary: "Generate new 2FA backup codes" })
  async generateBackupCodes(@Request() req, @Body() dto: Setup2faDto) {
    const codes = await this.authService.generateBackupCodes(
      req.user.realUserId,
      dto.code,
    );
    return { codes };
  }

  @Get("oidc/confirm-link")
  @AllowDelegate()
  @SkipCsrf()
  @ApiOperation({ summary: "Confirm OIDC account linking via email token" })
  async confirmOidcLink(@Query("token") token: string, @Res() res: Response) {
    const frontendUrl = this.configService.get<string>(
      "PUBLIC_APP_URL",
      "http://localhost:3000",
    );

    try {
      if (!token) {
        throw new BadRequestException(
          tr("errors.auth.missingLinkToken", "Missing link token"),
        );
      }
      await this.authService.confirmOidcLink(token);
      res.redirect(`${frontendUrl}/auth/callback?link=success`);
    } catch (error) {
      this.logger.error(
        "OIDC link confirmation error",
        error instanceof Error ? error.stack : undefined,
      );
      res.redirect(`${frontendUrl}/auth/callback?link=failed`);
    }
  }

  @Post("logout")
  @SkipCsrf()
  @AllowDelegate()
  @ApiOperation({ summary: "Logout current user" })
  async logout(@Request() req: ExpressRequest, @Res() res: Response) {
    // Revoke the refresh token family in the database
    const refreshToken = req.cookies?.["refresh_token"];
    if (refreshToken) {
      await this.authService.revokeRefreshToken(refreshToken);
    }

    this.clearAuthCookies(res);
    res.json({ message: "Logged out successfully" });
  }
}
