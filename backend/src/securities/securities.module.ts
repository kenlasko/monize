import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Security } from './entities/security.entity';
import { Holding } from './entities/holding.entity';
import { InvestmentTransaction } from './entities/investment-transaction.entity';
import { SecurityPrice } from './entities/security-price.entity';
import { Account } from '../accounts/entities/account.entity';
import { SecuritiesService } from './securities.service';
import { HoldingsService } from './holdings.service';
import { InvestmentTransactionsService } from './investment-transactions.service';
import { PortfolioService } from './portfolio.service';
import { SecuritiesController } from './securities.controller';
import { HoldingsController } from './holdings.controller';
import { InvestmentTransactionsController } from './investment-transactions.controller';
import { PortfolioController } from './portfolio.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Security,
      Holding,
      InvestmentTransaction,
      SecurityPrice,
      Account,
    ]),
    AccountsModule,
    TransactionsModule,
  ],
  providers: [
    SecuritiesService,
    HoldingsService,
    InvestmentTransactionsService,
    PortfolioService,
  ],
  controllers: [
    SecuritiesController,
    HoldingsController,
    InvestmentTransactionsController,
    PortfolioController,
  ],
  exports: [
    SecuritiesService,
    HoldingsService,
    InvestmentTransactionsService,
    PortfolioService,
  ],
})
export class SecuritiesModule {}
