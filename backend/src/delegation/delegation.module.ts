import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";

import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { DelegationService } from "./delegation.service";
import { DelegationController } from "./delegation.controller";
import { AccountDelegateGuard } from "./guards/account-delegate.guard";
import { DelegateTransferMaskInterceptor } from "./interceptors/delegate-transfer-mask.interceptor";
import { NotificationsModule } from "../notifications/notifications.module";

/**
 * Self-contained: registers its own JwtModule (same secret) so the global
 * AccountDelegateGuard can verify tokens without importing AuthModule, which
 * keeps AuthModule -> DelegationModule one-directional (no circular import).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AccountDelegate,
      AccountDelegateGrant,
      User,
      UserPreference,
      RefreshToken,
      Account,
      Transaction,
    ]),
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
  controllers: [DelegationController],
  providers: [
    DelegationService,
    AccountDelegateGuard,
    DelegateTransferMaskInterceptor,
    // Providing APP_GUARD here registers it globally (Nest treats the
    // APP_GUARD token specially regardless of the declaring module).
    { provide: APP_GUARD, useExisting: AccountDelegateGuard },
  ],
  exports: [
    DelegationService,
    AccountDelegateGuard,
    DelegateTransferMaskInterceptor,
  ],
})
export class DelegationModule {}
