import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BackupController } from "./backup.controller";
import { AutoBackupController } from "./auto-backup.controller";
import { BackupService } from "./backup.service";
import { BackupExportService } from "./backup-export.service";
import { BackupRestoreService } from "./backup-restore.service";
import { BackupAttachmentTransferService } from "./backup-attachment-transfer.service";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";
import { AutoBackupService } from "./auto-backup.service";
import { BackupEncryptionService } from "./backup-encryption.service";
import { SupportBackupService } from "./support-backup/support-backup.service";
import { BackupOffsiteController } from "./offsite/backup-offsite.controller";
import { BackupOffsiteSettingsService } from "./offsite/backup-offsite-settings.service";
import { BackupOffsiteS3Uploader } from "./offsite/backup-offsite-s3.uploader";
import { BackupOffsiteEmailSender } from "./offsite/backup-offsite-email.sender";
import { BackupOffsiteDispatchService } from "./offsite/backup-offsite-dispatch.service";
import { BackupOffsiteRetryService } from "./offsite/backup-offsite-retry.service";
import { AuthModule } from "../auth/auth.module";
import { EncryptionModule } from "../common/encryption/encryption.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { SystemAlertsModule } from "../system-alerts/system-alerts.module";
import { NotificationsModule } from "../notifications/notifications.module";

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
  ],
  controllers: [
    BackupController,
    AutoBackupController,
    // Not admin-only: a destination is the user's decision about their own
    // data leaving the machine, unlike the schedule and the folder.
    BackupOffsiteController,
  ],
  providers: [
    // The four components issue #1092 split BackupService into; BackupService
    // itself is now the facade over the first two.
    BackupExportService,
    BackupRestoreService,
    BackupAttachmentTransferService,
    BackupRestoreDatabaseService,
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
  exports: [BackupEncryptionService],
})
export class BackupModule {}
