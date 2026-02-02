import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Request,
  Res,
  Query,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Response, Request as ExpressRequest } from 'express';

import { AuthService } from './auth.service';
import { OidcService } from './oidc/oidc.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private localAuthEnabled: boolean;

  constructor(
    private authService: AuthService,
    private oidcService: OidcService,
    private configService: ConfigService,
  ) {
    // Default to true if not explicitly set to 'false'
    const localAuthSetting = this.configService.get<string>('LOCAL_AUTH_ENABLED', 'true');
    this.localAuthEnabled = localAuthSetting.toLowerCase() !== 'false';
  }

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { ttl: 900000, limit: 5 } }) // 5 attempts per 15 minutes
  @ApiOperation({ summary: 'Register a new user with local credentials' })
  @ApiResponse({ status: 403, description: 'Local authentication is disabled' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async register(@Body() registerDto: RegisterDto, @Res() res: Response) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException('Local authentication is disabled. Please use OIDC to sign in.');
    }
    const result = await this.authService.register(registerDto);

    // Set token as httpOnly cookie (SECURE - not accessible to JavaScript)
    res.cookie('auth_token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Return user without token (token is in httpOnly cookie)
    res.json({ user: result.user });
  }

  @Post('login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ auth: { ttl: 900000, limit: 5 } }) // 5 attempts per 15 minutes
  @ApiOperation({ summary: 'Login with local credentials' })
  @ApiResponse({ status: 403, description: 'Local authentication is disabled' })
  @ApiResponse({ status: 429, description: 'Too many requests' })
  async login(@Body() loginDto: LoginDto, @Res() res: Response) {
    if (!this.localAuthEnabled) {
      throw new ForbiddenException('Local authentication is disabled. Please use OIDC to sign in.');
    }
    const result = await this.authService.login(loginDto);

    // Set token as httpOnly cookie (SECURE - not accessible to JavaScript)
    res.cookie('auth_token', result.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Return user without token (token is in httpOnly cookie)
    res.json({ user: result.user });
  }

  @Get('oidc')
  @ApiOperation({ summary: 'Initiate OIDC authentication' })
  @ApiResponse({ status: 302, description: 'Redirects to OIDC provider' })
  @ApiResponse({ status: 400, description: 'OIDC not configured' })
  async oidcLogin(@Res() res: Response) {
    if (!this.oidcService.enabled) {
      throw new BadRequestException('OIDC authentication is not configured');
    }

    const state = this.oidcService.generateState();
    const nonce = this.oidcService.generateNonce();

    // Store state/nonce in secure cookies for validation
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 600000, // 10 minutes
    };

    res.cookie('oidc_state', state, cookieOptions);
    res.cookie('oidc_nonce', nonce, cookieOptions);

    const authUrl = this.oidcService.getAuthorizationUrl(state, nonce);
    res.redirect(authUrl);
  }

  @Get('oidc/callback')
  @ApiOperation({ summary: 'OIDC callback handler' })
  async oidcCallback(
    @Query() query: Record<string, string>,
    @Request() req: ExpressRequest,
    @Res() res: Response,
  ) {
    const frontendUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    try {
      const state = req.cookies?.['oidc_state'];
      const nonce = req.cookies?.['oidc_nonce'];

      // Clear OIDC cookies
      res.clearCookie('oidc_state');
      res.clearCookie('oidc_nonce');

      if (!state || !nonce) {
        throw new Error('Missing OIDC state or nonce - session may have expired');
      }

      // Handle callback with OIDC provider
      const tokenSet = await this.oidcService.handleCallback(query, state, nonce);

      if (!tokenSet.access_token) {
        throw new Error('No access token received from OIDC provider');
      }

      // Get user info from OIDC provider
      const userInfo = await this.oidcService.getUserInfo(tokenSet.access_token);

      // Find or create user
      const user = await this.authService.findOrCreateOidcUser(userInfo);

      // Generate our JWT token
      const token = this.authService.generateToken(user);

      // Set token as httpOnly cookie (SECURE - not in URL)
      res.cookie('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      res.redirect(`${frontendUrl}/auth/callback?success=true`);
    } catch (error) {
      // SECURITY: Log detailed error server-side only, don't expose to client
      this.logger.error('OIDC callback error', error.stack);
      // Return generic error message to prevent information disclosure
      res.redirect(`${frontendUrl}/auth/callback?error=authentication_failed`);
    }
  }

  @Get('oidc/status')
  @ApiOperation({ summary: 'Check if OIDC is enabled' })
  @ApiResponse({ status: 200, description: 'Returns OIDC enabled status' })
  async oidcStatus() {
    return { enabled: this.oidcService.enabled };
  }

  @Get('methods')
  @ApiOperation({ summary: 'Get available authentication methods' })
  @ApiResponse({ status: 200, description: 'Returns available authentication methods' })
  async getAuthMethods() {
    return {
      local: this.localAuthEnabled,
      oidc: this.oidcService.enabled,
    };
  }

  @Get('profile')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getProfile(@Request() req) {
    return req.user;
  }

  @Post('logout')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout current user' })
  async logout(@Res() res: Response) {
    // Clear the auth cookie
    res.clearCookie('auth_token');
    res.json({ message: 'Logged out successfully' });
  }
}
