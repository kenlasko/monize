import { SharedReviewModule } from "./shared-review.module";
import { SharedEntryFinanceController } from "./shared-entry-finance.controller";
import { SharedEntryFinanceService } from "./shared-entry-finance.service";
import { SharedNotificationsService } from "./shared-notifications.service";
import { SharedCollaborationService } from "./shared-collaboration.service";
import { SharedNotificationsInterceptor } from "./shared-notifications.interceptor";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module";
import { Module } from "@nestjs/common";
import { CurrenciesModule } from "../currencies/currencies.module";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { SharedExpensesController } from "./shared-expenses.controller";
import { SharedGroupsService } from "./shared-groups.service";
import { SharedEntriesService } from "./shared-entries.service";
import { SharedInvitationsService } from "./shared-invitations.service";
import { SharedMembershipsService } from "./shared-memberships.service";
import { SharedPeopleService } from "./shared-people.service";
import { SharedFinanceService } from "./shared-finance.service";
import { SharedFinanceController } from "./shared-finance.controller";
import { AccountsModule } from "../accounts/accounts.module";
import { NetWorthModule } from "../net-worth/net-worth.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { SharedDocumentsController } from "./shared-documents.controller";
import { SharedDocumentsService } from "./shared-documents.service";

@Module({
  imports: [
    SharedReviewModule,
    SystemAlertsModule,
    CurrenciesModule,
    EncryptionModule,
    AccountsModule,
    NetWorthModule,
    AttachmentsModule,
  ],
  controllers: [
    SharedEntryFinanceController,
    SharedExpensesController,
    SharedFinanceController,
    SharedDocumentsController,
  ],
  providers: [
    SharedEntryFinanceService,
    SharedCollaborationService,
    SharedNotificationsService,
    SharedNotificationsInterceptor,
    SharedGroupsService,
    SharedEntriesService,
    SharedInvitationsService,
    SharedMembershipsService,
    SharedPeopleService,
    SharedFinanceService,
    SharedDocumentsService,
  ],
  exports: [
    SharedGroupsService,
    SharedEntriesService,
    SharedNotificationsService,
  ],
})
export class SharedExpensesModule {}
