import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiActionBuilderService } from "./ai-action-builder.service";

/**
 * Minimal shared module for proposing human-in-the-loop write actions. It holds
 * only the dependency-light pieces (HMAC signing + the action builder) so both
 * the AI Assistant (`AiModule`) and the MCP server (`McpModule`) can mint the
 * same signed `PendingAiAction` without `McpModule` having to import the whole
 * `AiModule`.
 */
@Module({
  imports: [ConfigModule],
  providers: [AiActionSigningService, AiActionBuilderService],
  exports: [AiActionSigningService, AiActionBuilderService],
})
export class AiActionBuilderModule {}
