import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Institution } from "./entities/institution.entity";
import { Account } from "../accounts/entities/account.entity";
import { InstitutionsService } from "./institutions.service";
import { InstitutionLogoService } from "./institution-logo.service";
import { InstitutionsController } from "./institutions.controller";
import { ActionHistoryModule } from "../action-history/action-history.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([Institution, Account]),
    ActionHistoryModule,
  ],
  providers: [InstitutionsService, InstitutionLogoService],
  controllers: [InstitutionsController],
  exports: [InstitutionsService],
})
export class InstitutionsModule {}
