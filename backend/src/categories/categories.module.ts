import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Category } from "./entities/category.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { CategoriesService } from "./categories.service";
import { CategoriesController } from "./categories.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Category,
      Transaction,
      TransactionSplit,
      Payee,
      ScheduledTransaction,
      ScheduledTransactionSplit,
    ]),
  ],
  providers: [CategoriesService],
  controllers: [CategoriesController],
  exports: [CategoriesService],
})
export class CategoriesModule {}
