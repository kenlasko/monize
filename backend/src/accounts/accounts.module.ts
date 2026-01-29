import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from './entities/account.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { InvestmentTransaction } from '../securities/entities/investment-transaction.entity';
import { AccountsService } from './accounts.service';
import { AccountsController } from './accounts.controller';
import { CategoriesModule } from '../categories/categories.module';
import { ScheduledTransactionsModule } from '../scheduled-transactions/scheduled-transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Account, Transaction, InvestmentTransaction]),
    forwardRef(() => CategoriesModule),
    forwardRef(() => ScheduledTransactionsModule),
  ],
  providers: [AccountsService],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class AccountsModule {}
