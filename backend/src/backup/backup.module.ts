import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BackupController } from "./backup.controller";
import { AutoBackupController } from "./auto-backup.controller";
import { BackupService } from "./backup.service";
import { BackupExportService } from "./backup-export.service";
import { BackupRestoreService } from "./backup-restore.service";
import { BackupAttachmentTransferService } from "./backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";
import { BackupBondSeriesRecoveryService } from "./backup-bond-series-recovery.service";
import { AutoBackupService } from "./auto-backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { SupportBackupService } from "./support-backup/support-backup.service";
import { BackupOffsiteController } from "./offsite/backup-offsite.controller";
import { BackupOffsiteSettingsService } from "./offsite/backup-offsite-settings.service";
import { BackupOffsiteS3Uploader } from "./offsite/backup-offsite-s3.uploader";
import { BackupOffsiteEmailSender } from "./offsite/backup-offsite-email.sender";
import { BackupOffsiteDispatchService } from "./offsite/backup-offsite-dispatch.service";
import { BackupOffsiteRetryService } from "./offsite/backup-offsite-retry.service";
import { LocalBackupStorageTarget } from "./storage/local-backup-storage.target";
import { S3BackupStorageTarget } from "./storage/s3-backup-storage.target";
import { resolveBackupStoreProvider } from "./storage/backup-store-config";
import { BACKUP_STORAGE_TARGET } from "./storage/backup-storage.interface";
import { AuthModule } from "../auth/auth.module";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BondsModule } from "../bonds/bonds.module";
import { CurrenciesModule } from "../currencies/currencies.module";

@Module({
  imports: [
    AuthModule,
    EncryptionModule,
    ConfigModule,
    AttachmentsModule,
    // AutoBackupService raises BACKUP_FAILED / BACKUP_PARTIAL admin alerts.
    SystemAlertsModule,
    // For EmailService: the emailed off-machine copy of a completed artifact
    // (`docs/specs/backup-off-machine.md` section 5). A bare edge -- nothing
    // reachable from NotificationsModule imports this module back, so it cannot
    // lie on a require cycle (`src/module-graph.spec.ts`).
    NotificationsModule,
    // BackupRestoreService recomputes the engine prices of a restored bond link,
    // and its series recovery fetches a referenced series (BondSeriesService).
    BondsModule,
    // The restore tells the crypto exchange rate adapter to re-read
    // `currencies` after it commits (CryptoFxProvider).
    CurrenciesModule,
  ],
  controllers: [
    BackupController,
    AutoBackupController,
    // Not admin-only: a destination is the user's decision about their own
    // data leaving the machine, unlike the schedule and the folder.
    BackupOffsiteController,
  ],
  providers: [
    // Where the automatic backup artifacts live, selected by
    // BACKUP_STORAGE_PROVIDER and registered the way ATTACHMENT_STORAGE_PROVIDER
    // is in `attachments.module.ts`: every implementation a provider, one
    // factory choosing by configuration, so nothing downstream of the store
    // knows which one is bound. `docs/specs/backup-storage-targets.md`.
    LocalBackupStorageTarget,
    S3BackupStorageTarget,
    {
      provide: BACKUP_STORAGE_TARGET,
      useFactory: (
        config: ConfigService,
        local: LocalBackupStorageTarget,
        s3: S3BackupStorageTarget,
      ) =>
        resolveBackupStoreProvider((name) => config.get<string>(name)) === "s3"
          ? s3
          : local,
      inject: [ConfigService, LocalBackupStorageTarget, S3BackupStorageTarget],
    },
    // The four components issue #1092 split BackupService into; BackupService
    // itself is now the facade over the first two.
    BackupExportService,
    BackupRestoreService,
    BackupAttachmentTransferService,
    BackupRestoreDatabaseService,
    // Fetches the bond series a restored file references and the catalog lacks.
    BackupBondSeriesRecoveryService,
    BackupService,
    AutoBackupService,
    BackupEncryptionService,
    SupportBackupService,
    // The off-machine copy: the user's destinations, and the append-only
    // uploader that is the only S3 surface this path has (INV-BACKUP-004).
    BackupOffsiteSettingsService,
    BackupOffsiteS3Uploader,
    BackupOffsiteEmailSender,
    // The dispatch on the tail of a completed backup, and the hourly sweep that
    // re-attempts what failed -- one claim and one perform, shared.
    BackupOffsiteDispatchService,
    BackupOffsiteRetryService,
  ],
  // AutoBackupService is exported for the admin user list's storage column: it
  // owns the per-user namespace inside the store, so how much a user's backups
  // occupy is its question to answer and not one an admin screen may compute
  // from a path of its own.
  exports: [BackupEncryptionService, AutoBackupService],
})
export class BackupModule {}
