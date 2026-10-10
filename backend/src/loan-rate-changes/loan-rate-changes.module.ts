import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { LoanRateChangesService } from "./loan-rate-changes.service";
import { RateChangeInferenceService } from "./rate-change-inference.service";
import { LoanRateChangesController } from "./loan-rate-changes.controller";
import { LoanPaymentDetectorService } from "../accounts/loan-payment-detector.service";

@Module({
  // No scheduled-transactions import: the sync rewrites the bill through the
  // loan core's `rewriteLoanTemplate`, never through
  // `ScheduledTransactionsService` (pricing spec 7.5).
  imports: [TypeOrmModule.forFeature([LoanRateChange, Account, Transaction])],
  providers: [
    LoanRateChangesService,
    RateChangeInferenceService,
    // Provided here (not imported from AccountsModule) to avoid a module
    // cycle; the detector only depends on the Account/Transaction repos.
    LoanPaymentDetectorService,
  ],
  controllers: [LoanRateChangesController],
  exports: [LoanRateChangesService],
})
export class LoanRateChangesModule {}
