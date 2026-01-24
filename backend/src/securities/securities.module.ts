import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Security } from './entities/security.entity';
import { Holding } from './entities/holding.entity';
import { InvestmentTransaction } from './entities/investment-transaction.entity';
import { SecurityPrice } from './entities/security-price.entity';
import { SecuritiesService } from './securities.service';
import { HoldingsService } from './holdings.service';
import { InvestmentTransactionsService } from './investment-transactions.service';
import { SecuritiesController } from './securities.controller';
import { HoldingsController } from './holdings.controller';
import { InvestmentTransactionsController } from './investment-transactions.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Security,
      Holding,
      InvestmentTransaction,
      SecurityPrice,
    ]),
    AccountsModule,
    TransactionsModule,
  ],
  providers: [
    SecuritiesService,
    HoldingsService,
    InvestmentTransactionsService,
  ],
  controllers: [
    SecuritiesController,
    HoldingsController,
    InvestmentTransactionsController,
  ],
  exports: [
    SecuritiesService,
    HoldingsService,
    InvestmentTransactionsService,
  ],
})
export class SecuritiesModule {}
