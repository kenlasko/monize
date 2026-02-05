import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BuiltInReportsController } from './built-in-reports.controller';
import { BuiltInReportsService } from './built-in-reports.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { TransactionSplit } from '../transactions/entities/transaction-split.entity';
import { Category } from '../categories/entities/category.entity';
import { Payee } from '../payees/entities/payee.entity';
import { Account } from '../accounts/entities/account.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Category,
      Payee,
      Account,
    ]),
  ],
  controllers: [BuiltInReportsController],
  providers: [BuiltInReportsService],
  exports: [BuiltInReportsService],
})
export class BuiltInReportsModule {}
