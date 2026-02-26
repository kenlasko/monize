import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Currency } from "./entities/currency.entity";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { UserCurrencyPreference } from "./entities/user-currency-preference.entity";
import { Account } from "../accounts/entities/account.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "./exchange-rate.service";
import { CurrenciesService } from "./currencies.service";
import { CurrenciesController } from "./currencies.controller";
import { SecuritiesModule } from "../securities/securities.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Currency,
      ExchangeRate,
      UserCurrencyPreference,
      Account,
      UserPreference,
    ]),
    forwardRef(() => SecuritiesModule),
  ],
  providers: [ExchangeRateService, CurrenciesService],
  controllers: [CurrenciesController],
  exports: [ExchangeRateService, CurrenciesService],
})
export class CurrenciesModule {}
