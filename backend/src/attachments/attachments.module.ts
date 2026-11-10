import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AttachmentsController } from "./attachments.controller";
import { AttachmentsService } from "./attachments.service";
import { WarrantyAttachmentCopyController } from "./warranty-attachment-copy.controller";
import { WarrantyAttachmentCopyService } from "./warranty-attachment-copy.service";
import { AttachmentToolPrepService } from "./attachment-tool-prep.service";
import { AttachmentOrphanSweeper } from "./attachment-orphan-sweeper.service";
import { DatabaseStorageProvider } from "./storage/database-storage.provider";
import { LocalStorageProvider } from "./storage/local-storage.provider";
import { S3StorageProvider } from "./storage/s3-storage.provider";
import {
  ATTACHMENT_STORAGE_PROVIDER,
  AttachmentStorageProvider,
} from "./storage/attachment-storage.interface";
import { AttachmentStorageRegistry } from "./storage/attachment-storage.registry";
import { AttachmentStorageMigrator } from "./storage/attachment-storage-migrator.service";

/**
 * Transaction attachments. Bytes are stored via the injected storage provider,
 * selected by ATTACHMENT_STORAGE_PROVIDER: "database" (default) keeps bytes in
 * Postgres BYTEA; "local" writes them to a filesystem directory; "s3" stores
 * them in S3-compatible object storage. Entities are auto-registered via the
 * datasource glob, so no forFeature is needed -- the service reads repositories
 * from the withScopedDb EntityManager.
 *
 * That setting decides where the NEXT attachment's bytes go. Where an existing
 * one's bytes are is its own `storage_provider` column, and the two disagree for
 * as long as a switch takes to relocate -- so reads go through
 * `AttachmentStorageRegistry` (the row's backend) rather than the bound provider,
 * and `AttachmentStorageMigrator` moves them across in the background.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AttachmentsController, WarrantyAttachmentCopyController],
  providers: [
    AttachmentsService,
    WarrantyAttachmentCopyService,
    AttachmentToolPrepService,
    AttachmentOrphanSweeper,
    AttachmentStorageMigrator,
    DatabaseStorageProvider,
    LocalStorageProvider,
    S3StorageProvider,
    {
      provide: ATTACHMENT_STORAGE_PROVIDER,
      useFactory: (
        config: ConfigService,
        database: DatabaseStorageProvider,
        local: LocalStorageProvider,
        s3: S3StorageProvider,
      ) => {
        const kind = (
          config.get<string>("ATTACHMENT_STORAGE_PROVIDER") ?? "database"
        ).toLowerCase();
        if (kind === "s3") return s3;
        if (kind === "local") return local;
        return database;
      },
      inject: [
        ConfigService,
        DatabaseStorageProvider,
        LocalStorageProvider,
        S3StorageProvider,
      ],
    },
    {
      // Beside the factory above, and fed by it: one of these providers is where
      // new bytes go, and all three are how an existing row's bytes are reached.
      provide: AttachmentStorageRegistry,
      useFactory: (
        active: AttachmentStorageProvider,
        database: DatabaseStorageProvider,
        local: LocalStorageProvider,
        s3: S3StorageProvider,
      ) => new AttachmentStorageRegistry(active, [database, local, s3]),
      inject: [
        ATTACHMENT_STORAGE_PROVIDER,
        DatabaseStorageProvider,
        LocalStorageProvider,
        S3StorageProvider,
      ],
    },
  ],
  // The active provider is exported so the restore can stage external
  // attachment objects under their new keys (see BackupService); the registry
  // goes with it for anything that has to reach a row's own backend.
  exports: [
    AttachmentsService,
    AttachmentToolPrepService,
    ATTACHMENT_STORAGE_PROVIDER,
    AttachmentStorageRegistry,
    AttachmentOrphanSweeper,
  ],
})
export class AttachmentsModule {}
