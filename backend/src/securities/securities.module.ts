import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Security } from './entities/security.entity';
import { Holding } from './entities/holding.entity';
import { InvestmentTransaction } from './entities/investment-transaction.entity';
import { SecurityPrice } from './entities/security-price.entity';
import { Account } from '../accounts/entities/account.entity';
import { Transaction } from '../transactions/entities/transaction.entity';
import { UserPreference } from '../users/entities/user-preference.entity';
import { SecuritiesService } from './securities.service';
import { SecurityPriceService } from './security-price.service';
import { HoldingsService } from './holdings.service';
import { InvestmentTransactionsService } from './investment-transactions.service';
import { PortfolioService } from './portfolio.service';
import { SecuritiesController } from './securities.controller';
import { HoldingsController } from './holdings.controller';
import { InvestmentTransactionsController } from './investment-transactions.controller';
import { PortfolioController } from './portfolio.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { NetWorthModule } from '../net-worth/net-worth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Security,
      Holding,
      InvestmentTransaction,
      SecurityPrice,
      Account,
      Transaction,
      UserPreference,
    ]),
    AccountsModule,
    TransactionsModule,
    CurrenciesModule,
    NetWorthModule,
  ],
  providers: [
    SecuritiesService,
    SecurityPriceService,
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
    SecurityPriceService,
    HoldingsService,
    InvestmentTransactionsService,
    PortfolioService,
  ],
})
export class SecuritiesModule {}
