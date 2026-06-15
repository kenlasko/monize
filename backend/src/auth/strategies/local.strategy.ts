import { Strategy } from "passport-local";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../auth.service";
import { tr } from "../../i18n/translate";

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({
      usernameField: "email",
    });
  }

  async validate(email: string, password: string): Promise<any> {
    // Delegate to login() which handles lockout, rate limiting, and all
    // credential validation in a single place. This avoids duplicating
    // the validation logic that previously lived in validateUser().
    const result = await this.authService.login({ email, password });
    if (result.requires2FA) {
      throw new UnauthorizedException(
        tr(
          "errors.auth.twoFactorVerificationRequired",
          "2FA verification required",
        ),
      );
    }
    if (result.emailNotVerified) {
      throw new UnauthorizedException(
        tr(
          "errors.auth.emailNotVerified",
          "Please verify your email address before signing in. Check your inbox for the verification link.",
        ),
      );
    }
    return result.user;
  }
}
