import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Budget } from "./entities/budget.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { BudgetPeriod } from "./entities/budget-period.entity";
import { BudgetPeriodCategory } from "./entities/budget-period-category.entity";
import { BudgetAlert } from "./entities/budget-alert.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { BudgetsService } from "./budgets.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetsController } from "./budgets.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Budget,
      BudgetCategory,
      BudgetPeriod,
      BudgetPeriodCategory,
      BudgetAlert,
      Transaction,
      TransactionSplit,
      Category,
    ]),
  ],
  providers: [BudgetsService, BudgetPeriodService],
  controllers: [BudgetsController],
  exports: [BudgetsService, BudgetPeriodService],
})
export class BudgetsModule {}
