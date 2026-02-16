import { Global, Module } from "@nestjs/common";
import { DemoModeService } from "./demo-mode.service";

@Global()
@Module({
  providers: [DemoModeService],
  exports: [DemoModeService],
})
export class DemoModeModule {}
