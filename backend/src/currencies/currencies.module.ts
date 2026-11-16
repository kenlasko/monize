import { Module, forwardRef } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ExchangeRateService } from "./exchange-rate.service";
import { ExchangeRateHistoryService } from "./exchange-rate-history.service";
import { RateHistoryCatchUpService } from "./rate-history-catch-up.service";
import { CurrenciesService } from "./currencies.service";
import { CurrencyDetailService } from "./currency-detail.service";
import { CurrenciesController } from "./currencies.controller";
import { SecuritiesModule } from "../securities/securities.module";
import { ProviderHealthModule } from "../provider-health/provider-health.module";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { FxProviderChain } from "./providers/fx-provider-chain";
import {
  FX_PROVIDER_NAMES,
  FxProviderName,
  FxRateProvider,
} from "./providers/fx-provider.interface";
import { YahooFxProvider } from "./providers/yahoo-fx.provider";
import { CryptoFxProvider } from "./providers/crypto-fx.provider";
import {
  FrankfurterV2FxProvider,
  resolveFrankfurterV2BaseUrl,
} from "./providers/frankfurter-v2-fx.provider";

/**
 * Currencies and exchange rates. Rates come from a fixed chain of providers
 * built once here: the fiat providers in `FX_PROVIDER_NAMES` order (Frankfurter's
 * blended central-bank rates, then Yahoo Finance), then the crypto adapter,
 * handed to `FxProviderChain`, the one door every provider question goes
 * through (INV-FX-005). There is no provider configuration; only Frankfurter's
 * base URL is read (`FX_FRANKFURTER_V2_BASE_URL`, for a self-hosted instance).
 * The `Record` is typed over `FxProviderName`, so a name added to
 * `FX_PROVIDER_NAMES` without an adapter here fails to compile.
 *
 * The crypto adapter (`CryptoFxProvider`) is last: it is the only provider
 * that prices a coin and is asked about nothing else (it claims the coins,
 * `FxRateProvider.claims`; `docs/specs/crypto-accounts.md`, decision 5).
 */
@Module({
  imports: [
    ConfigModule,
    ProviderHealthModule,
    forwardRef(() => SecuritiesModule),
  ],
  providers: [
    ExchangeRateService,
    ExchangeRateHistoryService,
    RateHistoryCatchUpService,
    CurrenciesService,
    CurrencyDetailService,
    YahooFxProvider,
    CryptoFxProvider,
    {
      provide: FrankfurterV2FxProvider,
      useFactory: (
        configService: ConfigService,
        health: ProviderHealthService,
      ) =>
        new FrankfurterV2FxProvider(
          health,
          resolveFrankfurterV2BaseUrl(
            configService.get<string>("FX_FRANKFURTER_V2_BASE_URL"),
          ),
        ),
      inject: [ConfigService, ProviderHealthService],
    },
    {
      provide: FxProviderChain,
      useFactory: (
        frankfurterV2: FrankfurterV2FxProvider,
        yahoo: YahooFxProvider,
        crypto: CryptoFxProvider,
      ) => {
        const byName: Record<FxProviderName, FxRateProvider> = {
          frankfurter_v2: frankfurterV2,
          yahoo,
        };
        return new FxProviderChain([
          ...FX_PROVIDER_NAMES.map((name) => byName[name]),
          crypto,
        ]);
      },
      inject: [FrankfurterV2FxProvider, YahooFxProvider, CryptoFxProvider],
    },
  ],
  controllers: [CurrenciesController],
  exports: [
    ExchangeRateService,
    ExchangeRateHistoryService,
    // An import and a backup restore pull the rate history their rows need.
    RateHistoryCatchUpService,
    CurrenciesService,
    FxProviderChain,
    // The backup restore writes `currencies` and tells the crypto adapter to
    // re-read it after the commit, as `CurrenciesService` does on a write.
    CryptoFxProvider,
  ],
})
export class CurrenciesModule {}
