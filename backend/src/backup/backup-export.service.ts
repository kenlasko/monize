import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Writable } from "stream";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import {
  ATTACHMENT_STORAGE_PROVIDER,
  AttachmentStorageProvider,
} from "../attachments/storage/attachment-storage.interface";
import { resolveConfiguredBackupLimit } from "./backup-limits";
import { attachmentBytesConsistent } from "./attachment-integrity.util";
import { BACKUP_VERSION, BackupCompletenessReport } from "./backup-format";
import { createExportReader, ExportReader } from "./export-cursor";
import {
  AttachmentAudit,
  AttachmentReadResult,
  auditAttachments,
  externalAttachmentRows,
} from "./export-attachments";
import { ExportBufferSink } from "./export-buffer-sink";
import { collectExportTables, exportJsonChunks } from "./export-json-stream";
import { ExportWriter, RESPONSE_CLOSED_MESSAGE } from "./export-writer";
import {
  buildExportTableQueries,
  ExportTableQuery,
  INTENTIONALLY_EXCLUDED_TABLES,
} from "./export-table-queries";
import { tr } from "../i18n/translate";

/**
 * Everything that reads a user's data out into a backup artifact: the
 * `REPEATABLE READ` snapshot every table is read under, the per-table queries,
 * the streamed and buffered assemblies, the attachment bytes an object store has
 * to contribute, and the completeness report that says whether the artifact is
 * a backup of everything it names.
 *
 * Split out of `BackupService` (issue #1092). It knows nothing about restore:
 * the only thing the two halves share is the file format in `backup-format.ts`.
 *
 * ## What bounds the memory (issue #1070)
 *
 * Every export path here is a pull pipeline, and each stage bounds the next:
 *
 *  - `export-cursor.ts` fetches rows through a database cursor, so a table
 *    contributes a batch at a time rather than all of it. `attachment_blobs`
 *    fetches one row -- one base64-encoded object -- at a time.
 *  - `export-json-stream.ts` serialises one row at a time and flushes at a byte
 *    budget, instead of `JSON.stringify`-ing a whole table.
 *  - `export-attachments.ts` opens one object store object at a time, and reaches
 *    the completeness verdict from digests rather than from bytes, so the answer
 *    exists before the first byte without the bytes existing at all.
 *  - `export-writer.ts` resolves each write only once the pipeline has taken it,
 *    so a slow client stops the reads rather than queueing behind them, and an
 *    encrypted export writes a framed container instead of one AES-GCM message
 *    over the whole artifact.
 *
 * The irreducible part is one row: a 10 MiB attachment is 13.6 MiB of base64 no
 * matter what the budget says. Everything else is a constant.
 */

/**
 * How long an export may sit idle inside its snapshot transaction before the
 * database aborts it.
 *
 * The streaming export writes to the client between table reads, so a client
 * that stops draining holds the snapshot open -- and a long-lived
 * `REPEATABLE READ` transaction blocks vacuum from reclaiming dead tuples for
 * the whole database, not just this user's tables. Bounding the idle time turns
 * that from an operational problem into a failed download the user can retry
 * (audit DR-04).
 */
const EXPORT_IDLE_TIMEOUT_MS = 60_000;

@Injectable()
export class BackupExportService {
  private readonly logger = new Logger(BackupExportService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(ATTACHMENT_STORAGE_PROVIDER)
    private readonly attachmentStorage: AttachmentStorageProvider,
  ) {}

  /** Ceiling on the artifact a buffered export may accumulate. */
  get exportBufferLimitBytes(): number {
    return resolveConfiguredBackupLimit(
      "BACKUP_EXPORT_BUFFER_LIMIT",
      process.env.BACKUP_EXPORT_BUFFER_LIMIT,
      (message) => this.logger.warn(message),
    );
  }

  /**
   * The export's table list, with the external-attachment rows bound.
   *
   * `audit` is the pre-pass verdict, when there is one: the body then carries
   * exactly the objects the response headers said it would. Without it (the
   * support export, which assembles in memory and reports no completeness) each
   * object is verified as it is read, which is what the export always did.
   */
  private getTableQueries(audit?: AttachmentAudit): ExportTableQuery[] {
    return buildExportTableQueries(
      externalAttachmentRows(
        this.attachmentStorage.name,
        (id, row) => this.readAttachmentObject(id, row),
        {
          only: audit?.carriedExternalIds,
          onDivergence: (id) =>
            this.logger.warn(
              `Backup export could no longer read attachment object ${id} from the ` +
                `${this.attachmentStorage.name} store while writing the artifact, ` +
                `although it read it moments earlier. The download's completeness ` +
                `headers over-report by that attachment.`,
            ),
        },
      ),
    );
  }

  /**
   * Produces the full backup file as a Buffer -- gzipped JSON, optionally
   * encrypted -- alongside a report of whether every attachment's bytes made it
   * in. Used by the auto-backup path, which must not promote or retain an
   * incomplete artifact as if it were complete.
   *
   * This is the one export that still holds a whole artifact, because it writes a
   * file rather than a response. It holds the *compressed* artifact only, and
   * refuses past `BACKUP_EXPORT_BUFFER_LIMIT` with an error naming the table it
   * gave up at -- a pod dying mid-write leaves no artifact and no message.
   */
  async exportToBuffer(
    userId: string,
    encryptionPassword?: string,
  ): Promise<{ buffer: Buffer; report: BackupCompletenessReport }> {
    const limit = this.exportBufferLimitBytes;
    const sink = new ExportBufferSink(
      limit,
      (bytes, table) =>
        new BadRequestException(
          tr(
            "errors.backup.exportTooLarge",
            `This backup is too large to produce in one piece (past ${limit} bytes at table "${table}"). Automatic and support backups have to be held in memory; download a manual backup, which streams, or raise BACKUP_EXPORT_BUFFER_LIMIT.`,
            { limit, table: table ?? "" },
          ),
        ),
    );

    const report = await this.writeExport(userId, sink, encryptionPassword, {
      onChunkTable: (table) => sink.noteTable(table),
    });
    return { buffer: sink.toBuffer(), report };
  }

  /**
   * Streams a gzipped (and, with a password, framed-encrypted) backup to an
   * express response.
   *
   * Both paths stream. The encrypted one used to buffer the whole artifact
   * because AES-GCM's single auth tag needs the last byte of plaintext before it
   * can be computed; it now writes a framed container that authenticates each
   * chunk, so the difference between the two is one transform on the end of the
   * pipeline (issue #1070).
   */
  async streamExport(
    userId: string,
    res: import("express").Response,
    encryptionPassword?: string,
  ): Promise<void> {
    this.logger.log(
      `Starting backup export for user ${userId}${encryptionPassword ? " (encrypted)" : ""}`,
    );

    await this.writeExport(userId, res, encryptionPassword, {
      // Nothing has been sent yet, so the incompleteness can be *in the
      // response* rather than only in the log (F3RB-004).
      onReport: (report) => this.markIncompleteExport(res, report),
    });

    this.logger.log(
      `Backup export completed for user ${userId}${encryptionPassword ? " (encrypted)" : ""}`,
    );
  }

  /**
   * The one export pipeline, shared by the download and the file writer.
   *
   * The order is load-bearing: the completeness verdict is reached inside the
   * snapshot and **before** the pipeline is attached to its target, so the
   * response headers (and the filename) can still say the artifact is incomplete.
   * Once a byte has gone out there is nowhere left to put that.
   */
  private async writeExport(
    userId: string,
    target: Writable,
    encryptionPassword: string | undefined,
    hooks: {
      onReport?: (report: BackupCompletenessReport) => void;
      onChunkTable?: (table: string | null) => void;
    },
  ): Promise<BackupCompletenessReport> {
    const writer = await ExportWriter.create(target, encryptionPassword);
    const onTargetClose = (): void => {
      if (!target.writableFinished) {
        writer.abort(new Error(RESPONSE_CLOSED_MESSAGE));
      }
    };
    const onTargetError = (error: Error): void => writer.abort(error);
    target.once("close", onTargetClose);
    target.once("error", onTargetError);

    let completed = false;
    try {
      const report = await this.inExportSnapshot(userId, async (reader) => {
        const audit = await this.auditAttachments(userId, reader);
        this.warnIfIncompleteExport(userId, audit.report);
        hooks.onReport?.(audit.report);

        // Only now does anything reach the target, so the headers above are
        // still mutable.
        writer.start();
        const chunks = exportJsonChunks(reader, this.getTableQueries(audit), {
          exportedAt: new Date().toISOString(),
          // The durable copy of the completeness claim, inside the document
          // where a rename cannot lose it (issue #1069). It is the same report
          // the headers, the filename and the return value carry, so the four
          // cannot disagree about one artifact.
          completeness: audit.report,
        });
        for await (const chunk of chunks) {
          hooks.onChunkTable?.(chunk.table);
          await writer.write(chunk.text);
        }
        return audit.report;
      });
      // Outside the snapshot: every row has been read, so the transaction and its
      // pooled connection are released before the last bytes are flushed.
      await writer.finish();
      completed = true;
      return report;
    } finally {
      target.off("close", onTargetClose);
      target.off("error", onTargetError);
      if (!completed) writer.destroy();
    }
  }

  /**
   * Tell the client, in the response itself, that this artifact is incomplete
   * (F3RB-004).
   *
   * A download that the backend knows cannot restore everything it names used to
   * arrive as an ordinary 200 with the ordinary filename and an ordinary success
   * toast -- so a user could delete the source system on the strength of it. The
   * bytes are still sent, deliberately: a partial artifact is worth more than no
   * artifact when the alternative is losing the rest too. What changes is that it
   * cannot be mistaken for a complete one.
   *
   * Headers rather than the body because the body is a gzip/encrypted stream with
   * no place to put a status, and because this must work for the streaming path
   * where nothing can be added afterwards. `Content-Disposition` is rewritten so
   * the file on disk carries the warning too -- a header is invisible six months
   * later, a filename is not. Called before the first byte on both paths.
   */
  private markIncompleteExport(
    res: import("express").Response,
    report: BackupCompletenessReport,
  ): void {
    if (report.complete) return;
    res.setHeader("X-Backup-Complete", "false");
    res.setHeader(
      "X-Backup-Attachments-Expected",
      String(report.expectedAttachments),
    );
    res.setHeader(
      "X-Backup-Attachments-Included",
      String(report.includedAttachments),
    );
    res.setHeader(
      "X-Backup-Attachments-Missing",
      String(report.missingAttachments),
    );
    res.setHeader(
      "X-Backup-Attachments-Inconsistent",
      String(report.inconsistentAttachments),
    );
    // CORS: a browser cannot read a custom response header unless it is exposed.
    res.setHeader(
      "Access-Control-Expose-Headers",
      [
        "Content-Disposition",
        "X-Backup-Complete",
        "X-Backup-Attachments-Expected",
        "X-Backup-Attachments-Included",
        "X-Backup-Attachments-Missing",
        "X-Backup-Attachments-Inconsistent",
      ].join(", "),
    );

    const disposition = res.getHeader("Content-Disposition");
    if (typeof disposition === "string") {
      res.setHeader(
        "Content-Disposition",
        disposition.replace(
          /filename="([^"]+?)(\.json\.gz|\.mzbe)"/,
          'filename="$1-INCOMPLETE$2"',
        ),
      );
    }
  }

  /** Logs an incomplete manual export; the auto-backup path acts on it instead. */
  private warnIfIncompleteExport(
    userId: string,
    report: BackupCompletenessReport,
  ): void {
    if (report.complete) return;
    this.logger.warn(
      `Backup export for user ${userId} is incomplete: ` +
        `${report.missingAttachments} attachment(s) could not be included and ` +
        `${report.inconsistentAttachments} did not match their metadata, of ` +
        `${report.expectedAttachments} total. The artifact is not a complete ` +
        `backup of those attachments.`,
    );
  }

  /**
   * Runs `fn` with a reader bound to one consistent database snapshot.
   *
   * Every table query used to open its own short transaction, so the export saw
   * a different committed state per table -- and a backup taken while the user
   * was active could contain a child without its parent. Add an account and a
   * transaction for it between the `accounts` query and the `transactions`
   * query, and the artifact holds the transaction alone: valid gzip, valid
   * envelope, and a restore that fails on `transactions.account_id`. Other
   * interleavings drop dependent rows with no error at all.
   *
   * `REPEATABLE READ` fixes the snapshot at the transaction's first statement,
   * so every table is read as of one instant. READ COMMITTED would not do, even
   * inside a single transaction: it takes a fresh snapshot per statement, which
   * is the same problem with fewer transactions. It is also what makes the
   * completeness audit a fact rather than a forecast: the cursors that write the
   * body read the same snapshot the audit judged.
   *
   * The cost is a transaction held for the length of the export -- for the
   * streaming path, for the length of the download. That is one pooled
   * connection and a held xmin, which is the price of a backup that restores.
   */
  private inExportSnapshot<T>(
    userId: string,
    fn: (reader: ExportReader) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        // Bound how long this REPEATABLE READ snapshot may sit idle. The
        // streaming export holds the transaction open for as long as the client
        // takes to drain, and a long-lived transaction blocks vacuum from
        // reclaiming dead tuples across the whole database, not just this user's
        // tables. EXPORT_IDLE_TIMEOUT_MS turns a stalled download into an aborted
        // transaction the user can retry rather than an operational problem
        // (audit DR-04). `true` scopes the setting to this transaction.
        await manager.query(
          "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
          [String(EXPORT_IDLE_TIMEOUT_MS)],
        );
        return fn(createExportReader(manager, userId));
      },
      "REPEATABLE READ",
    );
  }

  /**
   * The set of tables the export writes (and the restore repopulates). Exposed
   * so the coverage guard test can assert every database table is either backed
   * up or explicitly excluded (see INTENTIONALLY_EXCLUDED_TABLES).
   */
  getBackedUpTableNames(): string[] {
    return this.getTableQueries().map((q) => q.key);
  }

  /** The tables deliberately omitted from backups, exposed for the guard test. */
  getIntentionallyExcludedTableNames(): string[] {
    return Array.from(INTENTIONALLY_EXCLUDED_TABLES);
  }

  /**
   * Collects the full export as an in-memory map of table -> rows, using the
   * same queries as the streamed/gzipped export. Consumed by the support
   * (de-identified) backup, which must hold every table at once to reconcile
   * scaled balances before serializing. Returns the same version/exportedAt
   * envelope fields the file format uses.
   */
  async collectRawExport(
    userId: string,
    options: { skipTables?: ReadonlySet<string> } = {},
  ): Promise<{
    version: number;
    exportedAt: string;
    tables: Record<string, Record<string, unknown>[]>;
  }> {
    const tables = await this.inExportSnapshot(userId, (reader) =>
      collectExportTables(reader, this.getTableQueries(), options.skipTables),
    );
    return {
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      tables,
    };
  }

  /**
   * Judges whether every attachment metadata row will have its bytes, and logs
   * what the object store could not supply.
   *
   * The judgement itself is in `export-attachments.ts`; what belongs here is the
   * storage provider and the logging, because this class owns both.
   */
  private async auditAttachments(
    userId: string,
    reader: ExportReader,
  ): Promise<AttachmentAudit> {
    const provider = this.attachmentStorage.name;
    const audit = await auditAttachments(reader, provider, (id, row) =>
      this.readAttachmentObject(id, row),
    );

    if (audit.unreadable > 0) {
      this.logger.warn(
        `Backup export could not read ${audit.unreadable} attachment object(s) from the ` +
          `${provider} store; their metadata travels without bytes and they will ` +
          `not be restorable.`,
      );
    }
    if (audit.inconsistent > 0) {
      this.logger.warn(
        `Backup export found ${audit.inconsistent} attachment(s) whose bytes no longer ` +
          `match their recorded size or checksum; they are omitted and will not be ` +
          `restorable from this artifact.`,
      );
    }
    if (audit.carriedExternalIds.size > 0) {
      this.logger.log(
        `Backup export is carrying ${audit.carriedExternalIds.size} external attachment ` +
          `object(s) from the ${provider} store for user ${userId}.`,
      );
    }
    return audit;
  }

  /**
   * Opens one attachment object and checks it against the row the server holds
   * for it.
   *
   * **This is the export's only read of an object store**, and the source guard
   * in `backup.service.spec.ts` keeps it that way. The distinction that guard
   * exists for: the id here was named by the *server*, from a `user_id`-scoped
   * query against its own database, so there is nothing to authorize -- unlike
   * the restore's staging read, which follows an id an *uploaded document*
   * named and has to consult the ownership record first.
   *
   * Two things are checked, not just loaded. An object the store cannot produce
   * is reported unreadable and omitted -- the ledger is the point of a backup,
   * and refusing the whole file over one unreadable receipt would leave the user
   * with nothing. And an object whose bytes no longer match the size and SHA-256
   * the server recorded is omitted too: export is the last moment to notice the
   * source is already corrupt, and packaging bytes the restore will refuse would
   * report a success the artifact cannot honour.
   *
   * The bytes are returned rather than retained. The audit drops them
   * immediately and the writer hands them to gzip a row at a time, so one object
   * is resident at once (issue #1070).
   */
  private async readAttachmentObject(
    id: string,
    row: Record<string, unknown>,
  ): Promise<AttachmentReadResult> {
    let bytes: Buffer;
    try {
      bytes = await this.attachmentStorage.load(id);
    } catch {
      return { status: "unreadable" };
    }
    // The metadata is the server's own record and the bytes are what the store
    // returned, so this compares the store against the database rather than the
    // file against itself.
    if (!attachmentBytesConsistent(bytes, row)) {
      return { status: "inconsistent" };
    }
    return { status: "ok", bytes };
  }
}
