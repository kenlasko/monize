import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Currency } from './entities/currency.entity';
import { ExchangeRate } from './entities/exchange-rate.entity';
import { Account } from '../accounts/entities/account.entity';
import { UserPreference } from '../users/entities/user-preference.entity';
import { ExchangeRateService } from './exchange-rate.service';
import { CurrenciesController } from './currencies.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Currency, ExchangeRate, Account, UserPreference])],
  providers: [ExchangeRateService],
  controllers: [CurrenciesController],
  exports: [ExchangeRateService],
})
export class CurrenciesModule {}
