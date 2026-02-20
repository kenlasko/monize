import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ReportsService } from "./reports.service";
import { ReportsController } from "./reports.controller";
import { CustomReport } from "./entities/custom-report.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { BudgetsModule } from "../budgets/budgets.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CustomReport,
      Transaction,
      TransactionSplit,
      Category,
      Payee,
    ]),
    BudgetsModule,
  ],
  providers: [ReportsService],
  controllers: [ReportsController],
  exports: [ReportsService],
})
export class ReportsModule {}
