import { Module } from "@nestjs/common";
import { HelpController } from "./help.controller";
import { HelpService } from "./help.service";

@Module({
  controllers: [HelpController],
  providers: [HelpService],
  exports: [HelpService],
})
export class HelpModule {}
