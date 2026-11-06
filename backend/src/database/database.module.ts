import { Module } from "@nestjs/common";
import { SeedService } from "./seed.service";
import { DemoSeedService } from "./demo-seed.service";
import { DemoResetService } from "./demo-reset.service";
import { FaviconModule } from "../common/favicon/favicon.module";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [FaviconModule, CurrenciesModule],
  providers: [SeedService, DemoSeedService, DemoResetService],
  exports: [SeedService, DemoSeedService],
})
export class DatabaseModule {}
