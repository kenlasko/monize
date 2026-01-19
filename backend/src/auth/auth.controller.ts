import {
  Controller,
  Post,
  Body,
  UseGuards,
  Get,
  Request,
  Res,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a new user with local credentials' })
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with local credentials' })
  async login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Get('oidc')
  @UseGuards(AuthGuard('oidc'))
  @ApiOperation({ summary: 'Initiate OIDC authentication' })
  oidcLogin() {
    // Guard redirects to OIDC provider
  }

  @Get('oidc/callback')
  @UseGuards(AuthGuard('oidc'))
  @ApiOperation({ summary: 'OIDC callback handler' })
  async oidcCallback(@Request() req, @Res() res: Response) {
    const token = this.authService.generateToken(req.user);

    // Redirect to frontend with token
    const frontendUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
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
  async logout() {
    return { message: 'Logged out successfully' };
  }
}
