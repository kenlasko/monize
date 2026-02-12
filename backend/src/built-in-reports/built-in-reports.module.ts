import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BuiltInReportsController } from "./built-in-reports.controller";
import { BuiltInReportsService } from "./built-in-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ComparisonReportsService } from "./comparison-reports.service";
import { AnomalyReportsService } from "./anomaly-reports.service";
import { TaxRecurringReportsService } from "./tax-recurring-reports.service";
import { DataQualityReportsService } from "./data-quality-reports.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Category,
      Payee,
      Account,
      UserPreference,
    ]),
    CurrenciesModule,
  ],
  controllers: [BuiltInReportsController],
  providers: [
    BuiltInReportsService,
    ReportCurrencyService,
    SpendingReportsService,
    IncomeReportsService,
    ComparisonReportsService,
    AnomalyReportsService,
    TaxRecurringReportsService,
    DataQualityReportsService,
  ],
  exports: [BuiltInReportsService],
})
export class BuiltInReportsModule {}
