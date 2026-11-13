import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { OidcService } from "./oidc/oidc.service";
import { OidcReauthService } from "./oidc/oidc-reauth.service";
import { PatService } from "./pat.service";
import { PasswordBreachService } from "./password-breach.service";
import { TokenService } from "./token.service";
import { TwoFactorService } from "./two-factor.service";
import { AuthEmailService } from "./auth-email.service";
import { AuthStateSweeperService } from "./auth-state-sweeper.service";
import { AuthAttemptCounterModule } from "./auth-attempt-counter.module";
import { SingleUseTokenModule } from "./single-use-token.module";
import { PatController } from "./pat.controller";
import { StepUpAuthService } from "./step-up/step-up.service";
import { StepUpAuthController } from "./step-up/step-up.controller";
import { StepUpGuard } from "./step-up/step-up.guard";
import { PatAccessGuard } from "./guards/pat-access.guard";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { DelegationModule } from "../delegation/delegation.module";

@Module({
  imports: [
    PassportModule,
    AuthAttemptCounterModule,
    SingleUseTokenModule,
    UsersModule,
    NotificationsModule,
    DelegationModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get("JWT_SECRET"),
        signOptions: {
          expiresIn: configService.get("JWT_EXPIRATION", "15m"),
          algorithm: "HS256" as const,
        },
        verifyOptions: {
          algorithms: ["HS256" as const],
        },
      }),
    }),
  ],
  providers: [
    AuthService,
    AuthStateSweeperService,
    TokenService,
    TwoFactorService,
    AuthEmailService,
    JwtStrategy,
    OidcService,
    OidcReauthService,
    PatService,
    PasswordBreachService,
    StepUpAuthService,
    StepUpGuard,
    PatAccessGuard,
    // Global: a PAT is refused on every route that did not opt in with
    // `@AllowPat()`, wherever the controller lives.
    { provide: APP_GUARD, useExisting: PatAccessGuard },
  ],
  controllers: [AuthController, PatController, StepUpAuthController],
  exports: [
    AuthService,
    AuthAttemptCounterModule,
    SingleUseTokenModule,
    TokenService,
    TwoFactorService,
    AuthEmailService,
    OidcService,
    OidcReauthService,
    PatService,
    PasswordBreachService,
    StepUpAuthService,
    StepUpGuard,
    JwtModule,
  ],
})
export class AuthModule {}
