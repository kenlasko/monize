import { Module } from "@nestjs/common";
import { AiRelayService } from "./ai-relay.service";
import { AiRelayController } from "./ai-relay.controller";
import { RelayAttachmentStore } from "./relay-attachment.store";

/**
 * Reverse MCP relay: routes AI chat prompts from the browser to the user's own
 * MCP agent and the answers back. AiRelayService and RelayAttachmentStore are
 * exported so the MCP relay tools and the attachment resource (in McpModule)
 * can claim prompts, post responses, and read uploaded attachments against the
 * same in-memory broker the browser controller feeds.
 */
@Module({
  providers: [AiRelayService, RelayAttachmentStore],
  controllers: [AiRelayController],
  exports: [AiRelayService, RelayAttachmentStore],
})
export class AiRelayModule {}
