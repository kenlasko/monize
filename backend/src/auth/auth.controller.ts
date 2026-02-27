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
import { Response, Request as ExpressRequest } from "express";

import { AuthService } from "./auth.service";
import { OidcService } from "./oidc/oidc.service";
import { EmailService } from "../notifications/email.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { VerifyTotpDto } from "./dto/verify-totp.dto";
import { Setup2faDto } from "./dto/setup-2fa.dto";
import { passwordResetTemplate } from "../notifications/email-templates";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import { SkipPasswordCheck } from "./decorators/skip-password-check.decorator";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { DemoModeService } from "../common/demo-mode.service";
import { generateCsrfToken, getCsrfCookieOptions } from "../common/csrf.util";

@ApiTags("Authentication")
@Controller("auth")
@SkipPasswordCheck()
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private localAuthEnabled: boolean;
  private registrationEnabled: boolean;
  private force2fa: boolean;
  private isProduction: boolean;

  constructor(
    private authService: AuthService,
    private oidcService: OidcService,
    private configService: ConfigService,
    private emailService: EmailService,
    private demoModeService: DemoModeService,
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
    this.isProduction =
      this.configService.get<string>("NODE_ENV") === "production";
  }

  private getAccessCookieOptions() {
    return {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: "lax" as const,
      maxAge: 15 * 60 * 1000, // 15 minutes (matches JWT expiry)
      path: "/",
    };
  }

  private getRefreshCookieOptions() {
    return {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: "strict" as const,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: "/",
    };
  }

  private setAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ) {
    res.cookie("auth_token", accessToken, this.getAccessCookieOptions());
    res.cookie("refresh_token", refreshToken, this.getRefreshCookieOptions());
    res.cookie(
      "csrf_token",
      generateCsrfToken(),
      getCsrfCookieOptions(this.isProduction),
    );
  }

  private clearAuthCookies(res: Response) {
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: "lax" as const,
      path: "/",
    });
    res.clearCookie("refresh_token", {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: "strict" as const,
      path: "/",
    });
    res.clearCookie("csrf_token", {
      secure: this.isProduction,
      sameSite: "lax" as const,
      path: "/",
    });
  }

  @Post("register")
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: 5 } }) // 5 attempts per 15 minutes
  @ApiOperation({ summary: "Register a new user with local credentials" })
  @ApiResponse({ status: 403, description: "Local authentication is disabled" })
  @ApiResponse({ status: 429, description: "Too many requests" })
  async register(@Body() registerDto: RegisterDto, @Res() res: Response) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException(
        "Local authentication is disabled. Please use OIDC to sign in.",
      );
    }
    if (!this.registrationEnabled) {
      throw new ForbiddenException("New account registration is disabled.");
    }
    const result = await this.authService.register(registerDto);

    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    res.json({ user: result.user });
  }

  @Post("login")
  @SkipCsrf()
  @Throttle({ default: { ttl: 900000, limit: 5 } }) // 5 attempts per 15 minutes
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
        "Local authentication is disabled. Please use OIDC to sign in.",
      );
    }
    const trustedDeviceToken = req.cookies?.["trusted_device"];
    const result = await this.authService.login(loginDto, trustedDeviceToken);

    // If 2FA is required, return temp token without setting cookie
    if (result.requires2FA) {
      return res.json({ requires2FA: true, tempToken: result.tempToken });
    }

    this.setAuthCookies(res, result.accessToken!, result.refreshToken!);
    res.json({ user: result.user });
  }

  @Get("oidc")
  @ApiOperation({ summary: "Initiate OIDC authentication" })
  @ApiResponse({ status: 302, description: "Redirects to OIDC provider" })
  @ApiResponse({ status: 400, description: "OIDC not configured" })
  async oidcLogin(@Res() res: Response) {
    if (!this.oidcService.enabled) {
      throw new BadRequestException("OIDC authentication is not configured");
    }

    const state = this.oidcService.generateState();
    const nonce = this.oidcService.generateNonce();

    // Store state/nonce in secure cookies for validation
    const cookieOptions = {
      httpOnly: true,
      secure: this.isProduction,
      sameSite: "lax" as const,
      maxAge: 600000, // 10 minutes
    };

    res.cookie("oidc_state", state, cookieOptions);
    res.cookie("oidc_nonce", nonce, cookieOptions);

    const authUrl = this.oidcService.getAuthorizationUrl(state, nonce);
    res.redirect(authUrl);
  }

  @Get("oidc/callback")
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

    try {
      const state = req.cookies?.["oidc_state"];
      const nonce = req.cookies?.["oidc_nonce"];

      // Clear OIDC cookies
      res.clearCookie("oidc_state");
      res.clearCookie("oidc_nonce");

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

      // Get user info from OIDC provider
      const userInfo = await this.oidcService.getUserInfo(
        tokenSet.access_token,
        tokenSet.sub,
      );

      // Find or create user
      const user = await this.authService.findOrCreateOidcUser(
        userInfo,
        this.registrationEnabled,
      );

      // Generate token pair
      const { accessToken, refreshToken } =
        await this.authService.generateTokenPair(user);

      this.setAuthCookies(res, accessToken, refreshToken);
      res.redirect(`${frontendUrl}/auth/callback?success=true`);
    } catch (error) {
      // SECURITY: Log detailed error server-side only, don't expose to client
      this.logger.error("OIDC callback error", error.stack);
      // Return generic error message to prevent information disclosure
      res.redirect(`${frontendUrl}/auth/callback?error=authentication_failed`);
    }
  }

  @Get("oidc/status")
  @ApiOperation({ summary: "Check if OIDC is enabled" })
  @ApiResponse({ status: 200, description: "Returns OIDC enabled status" })
  async oidcStatus() {
    return { enabled: this.oidcService.enabled };
  }

  @Get("methods")
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
  @ApiBearerAuth()
  @ApiOperation({ summary: "Refresh CSRF token cookie" })
  async csrfRefresh(@Res() res: Response) {
    res.cookie(
      "csrf_token",
      generateCsrfToken(),
      getCsrfCookieOptions(this.isProduction),
    );
    res.json({ message: "CSRF token refreshed" });
  }

  @Get("profile")
  @UseGuards(AuthGuard("jwt"))
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current user profile" })
  async getProfile(@Request() req) {
    const {
      passwordHash,
      resetToken,
      resetTokenExpiry,
      twoFactorSecret,
      ...user
    } = req.user;
    return { ...user, hasPassword: !!passwordHash };
  }

  @Post("forgot-password")
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: 3 } })
  @ApiOperation({ summary: "Request password reset email" })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException("Local authentication is disabled.");
    }

    const result = await this.authService.generateResetToken(dto.email);

    if (result && this.emailService.getStatus().configured) {
      const frontendUrl = this.configService.get<string>(
        "PUBLIC_APP_URL",
        "http://localhost:3000",
      );
      const resetUrl = `${frontendUrl}/reset-password?token=${result.token}`;
      const html = passwordResetTemplate(result.user.firstName || "", resetUrl);

      try {
        await this.emailService.sendMail(
          result.user.email!,
          "Monize Password Reset",
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
  @SkipCsrf()
  @DemoRestricted()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @ApiOperation({ summary: "Reset password using token" })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return { message: "Password reset successfully. You can now log in." };
  }

  @Post("2fa/verify")
  @SkipCsrf()
  @Throttle({ default: { ttl: 900000, limit: 5 } })
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

    this.setAuthCookies(res, result.accessToken, result.refreshToken);

    if (result.trustedDeviceToken) {
      res.cookie("trusted_device", result.trustedDeviceToken, {
        httpOnly: true,
        secure: this.isProduction,
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      });
    }

    res.json({ user: result.user });
  }

  @Post("2fa/setup")
  @UseGuards(AuthGuard("jwt"))
  @DemoRestricted()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Generate QR code and secret for 2FA setup" })
  async setup2FA(@Request() req) {
    return this.authService.setup2FA(req.user.id);
  }

  @Post("2fa/confirm-setup")
  @UseGuards(AuthGuard("jwt"))
  @DemoRestricted()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Confirm 2FA setup with verification code" })
  async confirmSetup2FA(@Request() req, @Body() dto: Setup2faDto) {
    return this.authService.confirmSetup2FA(req.user.id, dto.code);
  }

  @Post("2fa/disable")
  @UseGuards(AuthGuard("jwt"))
  @DemoRestricted()
  @ApiBearerAuth()
  @ApiOperation({ summary: "Disable 2FA with verification code" })
  async disable2FA(@Request() req, @Body() dto: Setup2faDto) {
    return this.authService.disable2FA(req.user.id, dto.code);
  }

  @Get("2fa/trusted-devices")
  @UseGuards(AuthGuard("jwt"))
  @ApiBearerAuth()
  @ApiOperation({ summary: "List trusted devices for the current user" })
  async getTrustedDevices(
    @Request() req: ExpressRequest & { user: any },
    @Res() res: Response,
  ) {
    const devices = await this.authService.getTrustedDevices(req.user.id);
    const currentToken = req.cookies?.["trusted_device"];
    let currentDeviceId: string | null = null;
    if (currentToken) {
      currentDeviceId = await this.authService.findTrustedDeviceByToken(
        req.user.id,
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
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke a specific trusted device" })
  async revokeTrustedDevice(
    @Request() req: ExpressRequest & { user: any },
    @Param("id", ParseUUIDPipe) deviceId: string,
    @Res() res: Response,
  ) {
    await this.authService.revokeTrustedDevice(req.user.id, deviceId);
    // If revoking the current device, clear the cookie
    const currentToken = req.cookies?.["trusted_device"];
    if (currentToken) {
      const currentDeviceId = await this.authService.findTrustedDeviceByToken(
        req.user.id,
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
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke all trusted devices" })
  async revokeAllTrustedDevices(
    @Request() req: ExpressRequest & { user: any },
    @Res() res: Response,
  ) {
    const count = await this.authService.revokeAllTrustedDevices(req.user.id);
    res.clearCookie("trusted_device");
    res.json({ message: `${count} device(s) revoked`, count });
  }

  @Post("refresh")
  @SkipCsrf()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // 10 refreshes per minute
  @ApiOperation({ summary: "Refresh access token using refresh token cookie" })
  async refresh(@Request() req: ExpressRequest, @Res() res: Response) {
    const refreshToken = req.cookies?.["refresh_token"];
    if (!refreshToken) {
      throw new UnauthorizedException("No refresh token provided");
    }

    try {
      const result = await this.authService.refreshTokens(refreshToken);
      this.setAuthCookies(res, result.accessToken, result.refreshToken);
      res.json({ message: "Token refreshed" });
    } catch (error) {
      this.clearAuthCookies(res);
      throw error;
    }
  }

  @Post("logout")
  @SkipCsrf()
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
