import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LoanFee } from "./entities/loan-fee.entity";
import { LoanFeesController } from "./loan-fees.controller";
import { LoanFeesService } from "./loan-fees.service";

/**
 * Mortgage fees (docs/specs/mortgage-fees.md). The pricing of a fee line is
 * the loan core's (`loan-installments/loan-fees.ts`) and the create path's
 * checks are plain functions in `loan-fee-terms.ts`, so no other module
 * imports this one and it imports none.
 */
@Module({
  imports: [TypeOrmModule.forFeature([LoanFee])],
  providers: [LoanFeesService],
  controllers: [LoanFeesController],
})
export class LoanFeesModule {}
