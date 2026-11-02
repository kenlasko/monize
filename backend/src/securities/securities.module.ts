import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { Security } from "./entities/security.entity";
import { SecurityTag } from "./entities/security-tag.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { SecurityPrice } from "./entities/security-price.entity";
import { SecurityDocument } from "./entities/security-document.entity";
import { MarketIndexPrice } from "./entities/market-index-price.entity";
import { MarketIndexSync } from "./entities/market-index-sync.entity";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Tag } from "../tags/entities/tag.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { SecuritiesService } from "./securities.service";
import { SecurityToolPrepService } from "./security-tool-prep.service";
import { SecurityPriceService } from "./security-price.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { MsnFinanceService } from "./msn-finance.service";
import { LseFinanceService } from "./lse-finance.service";
import { DeutscheBoerseFinanceService } from "./deutsche-boerse-finance.service";
import { HtmlTableFinanceService } from "./html-table-finance.service";
import { QuoteTablePreviewController } from "./quote-table-preview.controller";
import { QuoteProviderRegistry } from "./providers/quote-provider.registry";
import { HoldingsService } from "./holdings.service";
import { HoldingsDriftReportService } from "./holdings-drift-report.service";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import { TransferPairLinkService } from "./transfer-pair-link.service";
import { PortfolioService } from "./portfolio.service";
import { PortfolioSummaryInvalidationBridge } from "./portfolio-summary-invalidation.bridge";
import { DailyMovementService } from "./daily-movement.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import { SecurityDetailService } from "./security-detail.service";
import { SecurityDocumentsService } from "./security-documents.service";
import { SecurityNewsService } from "./security-news.service";
import { SectorWeightingService } from "./sector-weighting.service";
import { MarketIndexService } from "./market-index.service";
import { PerformanceComparisonService } from "./performance-comparison.service";
import { SecuritiesController } from "./securities.controller";
import { HoldingsController } from "./holdings.controller";
import { InvestmentTransactionsController } from "./investment-transactions.controller";
import { PortfolioController } from "./portfolio.controller";
import { PerformanceComparisonController } from "./performance-comparison.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { ActionHistoryModule } from "../action-history/action-history.module";
import { DelegationModule } from "../delegation/delegation.module";
import { ProviderHealthModule } from "../provider-health/provider-health.module";
import { BondsModule } from "../bonds/bonds.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Security,
      SecurityTag,
      Holding,
      InvestmentTransaction,
      SecurityPrice,
      SecurityDocument,
      MarketIndexPrice,
      MarketIndexSync,
      Account,
      Transaction,
      Tag,
      UserPreference,
    ]),
    ProviderHealthModule,
    forwardRef(() => AccountsModule),
    forwardRef(() => TransactionsModule),
    forwardRef(() => CurrenciesModule),
    // forwardRef on both: each lies on a require cycle, so a bare reference is
    // `undefined` here under some load orders -- see `src/module-graph.spec.ts`.
    forwardRef(() => NetWorthModule),
    ActionHistoryModule,
    forwardRef(() => DelegationModule),
    // A bond link recomputes the security's engine prices after its commit.
    forwardRef(() => BondsModule),
  ],
  providers: [
    SecuritiesService,
    TransferPairLinkService,
    SecurityToolPrepService,
    SecurityPriceService,
    YahooFinanceService,
    MsnFinanceService,
    LseFinanceService,
    DeutscheBoerseFinanceService,
    HtmlTableFinanceService,
    QuoteProviderRegistry,
    HoldingsService,
    HoldingsDriftReportService,
    InvestmentTransactionsService,
    PortfolioCalculationService,
    PortfolioService,
    // Subscribes this replica to memo invalidations and announces its own;
    // `EventBusModule` is `@Global()`, so no module edge is needed for it.
    PortfolioSummaryInvalidationBridge,
    DailyMovementService,
    SecurityDetailService,
    SecurityDocumentsService,
    SecurityNewsService,
    SectorWeightingService,
    MarketIndexService,
    PerformanceComparisonService,
  ],
  controllers: [
    SecuritiesController,
    HoldingsController,
    InvestmentTransactionsController,
    PortfolioController,
    PerformanceComparisonController,
    QuoteTablePreviewController,
  ],
  exports: [
    SecuritiesService,
    SecurityToolPrepService,
    SecurityPriceService,
    YahooFinanceService,
    MsnFinanceService,
    LseFinanceService,
    DeutscheBoerseFinanceService,
    HtmlTableFinanceService,
    QuoteProviderRegistry,
    HoldingsService,
    InvestmentTransactionsService,
    // The GEM report needs cost bases translated at each transaction's own
    // historical rate; converting a historical aggregate at today's rate is a
    // different (and wrong) number.
    PortfolioCalculationService,
    PortfolioService,
    SecurityDetailService,
    SecurityDocumentsService,
    SecurityNewsService,
    SectorWeightingService,
    MarketIndexService,
    PerformanceComparisonService,
  ],
})
export class SecuritiesModule {}
