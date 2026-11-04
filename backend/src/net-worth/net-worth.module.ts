import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import { Account } from "../accounts/entities/account.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Security } from "../securities/entities/security.entity";
import { ExchangeRate } from "../currencies/entities/exchange-rate.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { PortfolioPeriodResultsBatchService } from "./portfolio-period-results-batch.service";
import { SecurityPeriodResultsService } from "./security-period-results.service";
import { NetWorthController } from "./net-worth.controller";
import { DelegationModule } from "../delegation/delegation.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      MonthlyAccountBalance,
      Account,
      InvestmentTransaction,
      SecurityPrice,
      Security,
      ExchangeRate,
      UserPreference,
    ]),
    // forwardRef: this edge lies on a require cycle, so a bare reference is
    // `undefined` here under some load orders -- see `src/module-graph.spec.ts`.
    forwardRef(() => DelegationModule),
    // For BalanceThresholdAlertService: the debounced recalc timer is the
    // post-commit balance-invalidation seam, so it also evaluates balance-
    // threshold crossings there. NotificationsModule reaches back, so forwardRef.
    forwardRef(() => NotificationsModule),
    // For ExchangeRateService: a series read fills its own exchange-rate gaps
    // from the provider (`series-rate-fill.ts`). CurrenciesModule reaches back
    // here through SecuritiesModule, so forwardRef.
    forwardRef(() => CurrenciesModule),
  ],
  providers: [
    NetWorthService,
    PortfolioPeriodResultService,
    PortfolioPeriodResultsBatchService,
    SecurityPeriodResultsService,
  ],
  controllers: [NetWorthController],
  exports: [
    NetWorthService,
    PortfolioPeriodResultService,
    PortfolioPeriodResultsBatchService,
  ],
})
export class NetWorthModule {}
