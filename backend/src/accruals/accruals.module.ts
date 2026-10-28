import { Module } from "@nestjs/common";
import { AccrualsController } from "./accruals.controller";
import { AccrualsService } from "./accruals.service";

@Module({
  providers: [AccrualsService],
  controllers: [AccrualsController],
  exports: [AccrualsService],
})
export class AccrualsModule {}
