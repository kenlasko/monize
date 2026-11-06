import { AuthAttemptCounterModule } from "../auth/auth-attempt-counter.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { Module, forwardRef } from "@nestjs/common";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ProviderHealthModule } from "../provider-health/provider-health.module";
import { BenchmarkRefreshService } from "./benchmark-refresh.service";
import { BondCatalogService } from "./bond-catalog.service";
import { BondHoldingsService } from "./bond-holdings.service";
import { BondNotificationService } from "./bond-notification.service";
import { BondOfferService } from "./bond-offer.service";
import { BondPriceService } from "./bond-price.service";
import { BondSeriesService } from "./bond-series.service";
import { BondAuctionsService } from "./bond-auctions.service";
import { BondValuationService } from "./bond-valuation.service";
import { BondsController } from "./bonds.controller";
import { SeriesHttp } from "./series-http";

@Module({
  imports: [
    ProviderHealthModule,
    // The per-user cap on explicit series fetches (BondSeriesService).
    AuthAttemptCounterModule,
    // BondPriceService dispatches the net-worth recompute after a price write.
    // SecuritiesModule imports this module (a link recomputes the security's
    // prices) and NetWorthModule reaches SecuritiesModule back through
    // CurrenciesModule, so the edge lies on a require cycle: forwardRef.
    forwardRef(() => NetWorthModule),
    // The catalog seed creates an instrument's currency on demand.
    forwardRef(() => CurrenciesModule),
    // For NotificationDispatchService: the daily bond notification cron.
    forwardRef(() => NotificationsModule),
  ],
  controllers: [BondsController],
  providers: [
    BondValuationService,
    BondCatalogService,
    BenchmarkRefreshService,
    BondPriceService,
    SeriesHttp,
    BondSeriesService,
    BondAuctionsService,
    BondOfferService,
    BondHoldingsService,
    BondNotificationService,
  ],
  exports: [
    BondValuationService,
    BondPriceService,
    BondSeriesService,
    // The investment preview fills a bond redemption from its split.
    BondHoldingsService,
  ],
})
export class BondsModule {}
