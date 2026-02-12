import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ImportController } from "./import.controller";
import { ImportService } from "./import.service";
import { ImportEntityCreatorService } from "./import-entity-creator.service";
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Security } from "../securities/entities/security.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { SecuritiesModule } from "../securities/securities.module";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Transaction,
      TransactionSplit,
      Account,
      Category,
      Payee,
      Security,
      InvestmentTransaction,
      Holding,
    ]),
    forwardRef(() => NetWorthModule),
    forwardRef(() => SecuritiesModule),
    forwardRef(() => CurrenciesModule),
  ],
  controllers: [ImportController],
  providers: [
    ImportService,
    ImportEntityCreatorService,
    ImportInvestmentProcessorService,
    ImportRegularProcessorService,
  ],
  exports: [ImportService],
})
export class ImportModule {}
