import { Strategy, Issuer } from 'passport-openidconnect';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service';

@Injectable()
export class OidcStrategy extends PassportStrategy(Strategy, 'oidc') {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
  ) {
    const issuerUrl = configService.get('OIDC_ISSUER_URL') || 'http://localhost';
    const clientID = configService.get('OIDC_CLIENT_ID') || 'dummy';
    const clientSecret = configService.get('OIDC_CLIENT_SECRET') || 'dummy';
    const callbackURL = configService.get('OIDC_CALLBACK_URL') || 'http://localhost:3000/auth/callback';

    super({
      issuer: issuerUrl,
      authorizationURL: `${issuerUrl}/authorize`,
      tokenURL: `${issuerUrl}/token`,
      userInfoURL: `${issuerUrl}/userinfo`,
      clientID,
      clientSecret,
      callbackURL,
      scope: ['openid', 'profile', 'email'],
    });
  }

  async validate(
    issuer: string,
    profile: any,
    done: (err: any, user?: any) => void,
  ) {
    try {
      const user = await this.authService.validateOidcUser(profile);
      done(null, user);
    } catch (err) {
      done(err, null);
    }
  }
}
