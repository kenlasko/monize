import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OAuthPayload } from "./entities/oauth-payload.entity";
import { OauthInstanceConfig } from "./entities/oauth-instance-config.entity";
import { OauthSigningKeysService } from "./oauth-signing-keys.service";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { OAuthProviderService } from "./oauth-provider.service";
import { OAuthInteractionController } from "./oauth-interaction.controller";
import { OAuthMetadataController } from "./oauth-metadata.controller";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { OAUTH_GRANT_REVOKER } from "../auth/credential-revocation";

@Module({
  imports: [
    TypeOrmModule.forFeature([OAuthPayload, OauthInstanceConfig]),
    AuthModule,
    NotificationsModule,
    EncryptionModule,
  ],
  providers: [
    OAuthProviderService,
    OauthSigningKeysService,
    // What a password reset or change calls to end the account's OAuth grants
    // (`auth/credential-revocation.ts`), reachable without importing this class.
    { provide: OAUTH_GRANT_REVOKER, useExisting: OAuthProviderService },
  ],
  controllers: [OAuthInteractionController, OAuthMetadataController],
  exports: [OAuthProviderService],
})
export class OAuthModule {}
