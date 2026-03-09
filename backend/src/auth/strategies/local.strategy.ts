import { Strategy } from "passport-local";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthService } from "../auth.service";

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
      throw new UnauthorizedException("2FA verification required");
    }
    return result.user;
  }
}
