import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { OAuthPayload } from "./entities/oauth-payload.entity";
import { OAuthProviderService } from "./oauth-provider.service";
import { OAuthInteractionController } from "./oauth-interaction.controller";
import { OAuthMetadataController } from "./oauth-metadata.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [TypeOrmModule.forFeature([OAuthPayload]), AuthModule],
  providers: [OAuthProviderService],
  controllers: [OAuthInteractionController, OAuthMetadataController],
  exports: [OAuthProviderService],
})
export class OAuthModule {}
