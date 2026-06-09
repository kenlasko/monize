import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { User } from "../users/entities/user.entity";
import { SeedService } from "./seed.service";
import { DemoSeedService } from "./demo-seed.service";
import { DemoResetService } from "./demo-reset.service";
import { InstitutionLogoService } from "../institutions/institution-logo.service";

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [
    SeedService,
    DemoSeedService,
    DemoResetService,
    InstitutionLogoService,
  ],
  exports: [SeedService, DemoSeedService],
})
export class DatabaseModule {}
