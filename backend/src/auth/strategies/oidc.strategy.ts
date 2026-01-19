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
    const issuerUrl = configService.get('OIDC_ISSUER_URL');
    const clientID = configService.get('OIDC_CLIENT_ID');
    const clientSecret = configService.get('OIDC_CLIENT_SECRET');
    const callbackURL = configService.get('OIDC_CALLBACK_URL');

    // Only initialize if OIDC is configured
    if (issuerUrl && clientID) {
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
