import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from './entities/transaction.entity';
import { TransactionSplit } from './entities/transaction-split.entity';
import { Category } from '../categories/entities/category.entity';
import { InvestmentTransaction } from '../securities/entities/investment-transaction.entity';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { PayeesModule } from '../payees/payees.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, TransactionSplit, Category, InvestmentTransaction]),
    forwardRef(() => AccountsModule),
    PayeesModule,
  ],
  providers: [TransactionsService],
  controllers: [TransactionsController],
  exports: [TransactionsService],
})
export class TransactionsModule {}
