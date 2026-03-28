import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { LocalStrategy } from "./strategies/local.strategy";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { OidcService } from "./oidc/oidc.service";
import { PatService } from "./pat.service";
import { PasswordBreachService } from "./password-breach.service";
import { TokenService } from "./token.service";
import { TwoFactorService } from "./two-factor.service";
import { AuthEmailService } from "./auth-email.service";
import { PatController } from "./pat.controller";
import { UsersModule } from "../users/users.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      UserPreference,
      TrustedDevice,
      RefreshToken,
      PersonalAccessToken,
    ]),
    PassportModule,
    UsersModule,
    NotificationsModule,
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
    TokenService,
    TwoFactorService,
    AuthEmailService,
    LocalStrategy,
    JwtStrategy,
    OidcService,
    PatService,
    PasswordBreachService,
  ],
  controllers: [AuthController, PatController],
  exports: [
    AuthService,
    TokenService,
    TwoFactorService,
    AuthEmailService,
    OidcService,
    PatService,
    PasswordBreachService,
    JwtModule,
  ],
})
export class AuthModule {}
