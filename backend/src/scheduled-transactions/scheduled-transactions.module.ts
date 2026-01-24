import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduledTransaction } from './entities/scheduled-transaction.entity';
import { ScheduledTransactionSplit } from './entities/scheduled-transaction-split.entity';
import { ScheduledTransactionsService } from './scheduled-transactions.service';
import { ScheduledTransactionsController } from './scheduled-transactions.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ScheduledTransaction, ScheduledTransactionSplit]),
    AccountsModule,
    TransactionsModule,
  ],
  providers: [ScheduledTransactionsService],
  controllers: [ScheduledTransactionsController],
  exports: [ScheduledTransactionsService],
})
export class ScheduledTransactionsModule {}
