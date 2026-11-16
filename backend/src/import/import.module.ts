import { Module, forwardRef } from "@nestjs/common";
import { ImportController } from "./import.controller";
import { MnyImportController } from "./mny/mny-import.controller";
import { ImportService } from "./import.service";
import { ImportEntityCreatorService } from "./import-entity-creator.service";
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { MnyImportJobService } from "./mny/mny-import-job.service";
import { MnyImportService } from "./mny/mny-import.service";
import { ImportPostProcessingService } from "./import-post-processing.service";
import { MnyParserService } from "./mny/mny-parser.service";
import { MnyMarketRateService } from "./mny/mny-market-rates.service";
import { MnyStagingService } from "./mny/mny-staging.service";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";
import { UsersModule } from "../users/users.module";
import { TransactionRulesModule } from "../transaction-rules/transaction-rules.module";
import { TagsModule } from "../tags/tags.module";
import { TransactionsModule } from "../transactions/transactions.module";

@Module({
  imports: [
    forwardRef(() => NetWorthModule),
    forwardRef(() => SecuritiesModule),
    forwardRef(() => CurrenciesModule),
    forwardRef(() => UsersModule),
    TransactionRulesModule,
    TagsModule,
    // For TransactionsService.remove: "delete mine and import" of a possible
    // duplicate goes through the one delete path, in the import's transaction.
    TransactionsModule,
  ],
  controllers: [ImportController, MnyImportController],
  providers: [
    ImportService,
    ImportPostProcessingService,
    ImportEntityCreatorService,
    ImportInvestmentProcessorService,
    ImportRegularProcessorService,
    MnyStagingService,
    MnyParserService,
    MnyMarketRateService,
    MnyImportJobService,
    MnyImportService,
  ],
  exports: [
    ImportService,
    MnyStagingService,
    MnyParserService,
    MnyMarketRateService,
    MnyImportJobService,
    MnyImportService,
  ],
})
export class ImportModule {}
