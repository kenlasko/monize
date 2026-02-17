import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ConfigModule } from "@nestjs/config";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiUsageLog } from "./entities/ai-usage-log.entity";
import { AiService } from "./ai.service";
import { AiUsageService } from "./ai-usage.service";
import { AiEncryptionService } from "./ai-encryption.service";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiController } from "./ai.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([AiProviderConfig, AiUsageLog]),
    ConfigModule,
  ],
  providers: [
    AiService,
    AiUsageService,
    AiEncryptionService,
    AiProviderFactory,
  ],
  controllers: [AiController],
  exports: [AiService, AiUsageService],
})
export class AiModule {}
