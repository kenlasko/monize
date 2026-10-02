import { Module, type OnModuleInit } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AccountsModule } from "../accounts/accounts.module";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { JobClaimModule } from "../common/jobs/job-claim.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PayeesModule } from "../payees/payees.module";
import { ProviderHealthModule } from "../provider-health/provider-health.module";
import { TagsModule } from "../tags/tags.module";
import { TransactionRulesModule } from "../transaction-rules/transaction-rules.module";
import { BankSyncConnectionsService } from "./bank-sync-connections.service";
import { BankSyncController } from "./bank-sync.controller";
import { BankSyncCredentialsService } from "./bank-sync-credentials.service";
import { BankSyncConsentReminderService } from "./bank-sync-consent-reminder.service";
import { BankSyncCronService } from "./bank-sync-cron.service";
import { BankSyncMatchService } from "./bank-sync-match.service";
import { BankSyncOutcomeNotifier } from "./bank-sync-outcome-notifier.service";
import { BankSyncPreviewService } from "./bank-sync-preview.service";
import { loadBankSyncProfiles } from "./bank-sync-profiles";
import { BankSyncService } from "./bank-sync.service";
import { BankSyncWriterService } from "./bank-sync-writer.service";
import { BankSyncProviderRegistry } from "./providers/bank-sync-provider.registry";
import { EnableBankingProvider } from "./providers/enable-banking/enable-banking.client";

/**
 * Bank sync (docs/specs/bank-sync.md). Nothing imports this module, so its
 * edges to the modules it reads through are bare: no require cycle can reach
 * back here (`src/module-graph.spec.ts`).
 *
 * The provider layer is registered here and reached only through
 * `BankSyncProviderRegistry`; a second aggregator is a new directory under
 * `providers/` and one provider line.
 *
 * The built-in source profiles (`profiles/`) are loaded and validated when the
 * module initialises, so a malformed file or one that carries personal data
 * stops the boot instead of failing the first sync.
 */
@Module({
  imports: [
    ConfigModule,
    EncryptionModule,
    JobClaimModule,
    ProviderHealthModule,
    AccountsModule,
    PayeesModule,
    TransactionRulesModule,
    // For TagsService.addTransactionTags: the operation-type tag is attached on
    // the writer's own manager, inside its transaction.
    TagsModule,
    NetWorthModule,
    // For NotificationDispatchService: the consent reminders and the daily
    // sync's outcomes are written through it so the bank sync categories'
    // matrix channels (immediate email, push) apply. NotificationsModule
    // imports nothing that imports back here, so the edge is bare.
    NotificationsModule,
  ],
  controllers: [BankSyncController],
  providers: [
    EnableBankingProvider,
    BankSyncProviderRegistry,
    BankSyncCredentialsService,
    BankSyncConnectionsService,
    BankSyncWriterService,
    BankSyncPreviewService,
    BankSyncService,
    BankSyncMatchService,
    BankSyncOutcomeNotifier,
    BankSyncCronService,
    BankSyncConsentReminderService,
  ],
})
export class BankSyncModule implements OnModuleInit {
  onModuleInit(): void {
    loadBankSyncProfiles();
  }
}
