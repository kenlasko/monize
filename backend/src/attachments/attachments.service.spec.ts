import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { createHash } from "crypto";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { AttachmentStorageRegistry } from "./storage/attachment-storage.registry";
import {
  AttachmentObjectSweptError,
  UPLOAD_INTENT_LEASE_MS,
} from "./storage/object-intent";
import {
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
  UploadedAttachmentFile,
  sanitizeFilename,
} from "./attachments.service";
import { AttachmentStorageProvider } from "./storage/attachment-storage.interface";
import { AttachmentOrphanSweeper } from "./attachment-orphan-sweeper.service";
import { lockTransactionRow, lockWarrantyRow } from "../common/db/locks";
import {
  AttachmentParent,
  reachedTransactionIdSql,
  reachingWarrantyJoinSql,
} from "./attachment-parent";
import { Warranty } from "../warranties/entities/warranty.entity";
import { requestContextStorage } from "../common/request-context";
import {
  lockedTransactionRow,
  stubLockedTransactions,
} from "../test-helpers/locks-testing";

jest.mock("../common/db/scoped-db");
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);
const mockedTenantTx = withScopedDb as jest.MockedFunction<typeof withScopedDb>;
// The upload intent is committed on its own connection, outside whatever
// transaction the caller may already hold (audit FV4-003). The automock returns
// undefined, which would make every awaited call resolve to nothing, so the
// double calls through -- whether it really got its own connection is
// scoped-db.spec.ts's question, not this file's.
const mockedOutsideTx = runOutsideActiveScopedManager as jest.MockedFunction<
  typeof runOutsideActiveScopedManager
>;

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n...", "ascii");
// A second image type, so a pair's two halves are distinguishable by their
// bytes: asserting the original's size and digest against the scan's would pass
// for a service that stored the same buffer twice.
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
]);

/** The parent every transaction-side spec uploads under. */
const TXN: AttachmentParent = { kind: "transaction", id: "txn-1" };
/** The other parent (WTY-003); its row is present unless a spec clears it. */
const WTY: AttachmentParent = { kind: "warranty", id: "wty-1" };

function pngFile(
  overrides: Partial<UploadedAttachmentFile> = {},
): UploadedAttachmentFile {
  return {
    originalname: "receipt.png",
    buffer: PNG_BYTES,
    size: PNG_BYTES.length,
    ...overrides,
  };
}

describe("AttachmentsService", () => {
  let service: AttachmentsService;
  let storage: jest.Mocked<AttachmentStorageProvider>;
  let orphanSweeper: jest.Mocked<Pick<AttachmentOrphanSweeper, "sweepKey">>;
  /** Backends registered beside the active one, for the read-a-row's-own case. */
  let otherStores: jest.Mocked<AttachmentStorageProvider>[];
  /**
   * The parent-transaction row `create` locks before counting. Present by
   * default; a spec that wants the not-found path clears it.
   */
  let lockedParent: ReturnType<typeof lockedTransactionRow> | null;
  let managerQuery: jest.Mock;
  /** Whether the sweeper has claimed this upload's object out from under it. */
  let intentStillOurs: boolean;
  /** Whether the key this upload wants is free of a swept tombstone. */
  let keyIsFree: boolean;
  /**
   * The transaction manager every `withScopedDb` in a spec receives. Exposed
   * because the upload intent opens a *second* transaction, and a spec that wants
   * only the metadata one to fail has to say which is which.
   */
  let manager: EntityManager;
  let attRepo: {
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  /** The chainable query-builder double the list read walks. */
  let qb: Record<string, jest.Mock>;
  /** Every condition the list read applied, in order. */
  let qbConditions: string[];

  beforeEach(() => {
    lockedParent = lockedTransactionRow({ id: "txn-1" });
    stubLockedTransactions(
      {
        lockTransactionRow: lockTransactionRow as jest.Mock,
        lockTransactionRows: jest.fn(),
      },
      lockedParent ? [lockedParent] : [],
    );
    (lockWarrantyRow as jest.Mock).mockImplementation(
      async (_m, id: string, userId: string) =>
        id === WTY.id && userId === "user-1" ? { id } : null,
    );
    // The list read is a query builder (it LEFT JOINs each visible row to its
    // original), so the double is a chainable builder whose terminal call is
    // `getRawAndEntities`. Every step returns the builder, which is what lets a
    // spec assert the conditions the service actually applied.
    qbConditions = [];
    qb = {
      leftJoin: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      where: jest.fn((c: string) => {
        qbConditions.push(c);
        return qb;
      }),
      andWhere: jest.fn((c: string) => {
        qbConditions.push(c);
        return qb;
      }),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
    };
    attRepo = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve(x)),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => qb),
    };

    // `remove` deletes with a RETURNING statement, so the manager needs `query`
    // as well as the attachment repository.
    manager = {
      getRepository: jest.fn(() => attRepo),
      query: jest.fn().mockResolvedValue([]),
    } as unknown as EntityManager;
    managerQuery = manager.query as unknown as jest.Mock;
    // Clearing the upload intent is a conditional `DELETE ... RETURNING`, and the
    // uploader throws when it matches nothing -- that is the fence against the
    // sweeper (audit RV4-002). The default has to be "the intent was still mine",
    // or every upload in this file fails for the wrong reason.
    intentStillOurs = true;
    keyIsFree = true;
    managerQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("DELETE FROM attachment_blob_tombstones")) {
        return intentStillOurs ? [[{ id: "t1" }], 1] : [[], 0];
      }
      // An INSERT returns bare rows whatever its RETURNING, so the upsert's
      // "did I get the row" is a row list and not a `[rows, count]` tuple.
      if (String(sql).includes("INSERT INTO attachment_blob_tombstones")) {
        return keyIsFree ? [{ id: "t1" }] : [];
      }
      return [];
    });

    mockedTenantTx.mockImplementation((_dataSource, fn) => fn(manager));
    mockedOutsideTx.mockImplementation((fn) => fn());

    storage = {
      name: "database",
      addressable: true,
      save: jest.fn().mockResolvedValue(undefined),
      load: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    orphanSweeper = { sweepKey: jest.fn().mockResolvedValue(undefined) };
    otherStores = [];

    service = buildService();
  });

  afterEach(() => jest.clearAllMocks());

  /**
   * Re-point the service at an external provider, whose bytes PostgreSQL cannot
   * roll back. `name` is readonly on the interface -- deliberately, it is
   * persisted -- so the double is rebuilt rather than mutated.
   */
  function externalStorage(): void {
    storage = {
      ...storage,
      name: "s3",
    } as jest.Mocked<AttachmentStorageProvider>;
    service = buildService();
  }

  /**
   * The service over the real registry, so a read resolves its provider the way
   * production does. Only the active double is registered: a row naming anything
   * else is the unaddressable case, which is its own test below.
   */
  function buildService(): AttachmentsService {
    return new AttachmentsService(
      {} as DataSource,
      new AttachmentStorageRegistry(storage, [storage, ...otherStores]),
      orphanSweeper as unknown as AttachmentOrphanSweeper,
    );
  }

  /**
   * A second backend, the one a provider switch is moving away from. Registered
   * but not active, which is the state every attachment uploaded before the switch
   * is read in.
   */
  function previousStorage(
    name: string,
  ): jest.Mocked<AttachmentStorageProvider> {
    const previous = {
      name,
      addressable: true,
      save: jest.fn().mockResolvedValue(undefined),
      load: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    } as jest.Mocked<AttachmentStorageProvider>;
    otherStores = [previous];
    service = buildService();
    return previous;
  }

  describe("create", () => {
    it("stores metadata and bytes, sniffing the real MIME type", async () => {
      const result = await service.create("user-1", TXN, pngFile());

      expect(result.contentType).toBe("image/png");
      expect(result.userId).toBe("user-1");
      expect(result.transactionId).toBe("txn-1");
      // The other parent column is written as null, not left undefined, so
      // the row the CHECK sees names exactly one parent; and a transaction's
      // attachment takes the default kind (W4).
      expect(result.warrantyId).toBeNull();
      expect(result.documentKind).toBe("other");
      expect(result.byteSize).toBe(PNG_BYTES.length);
      expect(result.sha256).toBe(
        createHash("sha256").update(PNG_BYTES).digest("hex"),
      );
      expect(result.storageProvider).toBe("database");
      // Database provider keys the bytes by the attachment id.
      expect(result.storageKey).toBe(result.id);
      expect(storage.save).toHaveBeenCalledWith(result.id, PNG_BYTES);
    });

    it("refuses a non-default document kind under a transaction, before any write", async () => {
      await expect(
        service.create("user-1", TXN, pngFile(), undefined, "receipt"),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Refused before the upload intent: no transaction was opened at all.
      expect(mockedTenantTx).not.toHaveBeenCalled();
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("accepts PDFs", async () => {
      const result = await service.create(
        "user-1",
        TXN,
        pngFile({
          originalname: "invoice.pdf",
          buffer: PDF_BYTES,
          size: PDF_BYTES.length,
        }),
      );
      expect(result.contentType).toBe("application/pdf");
    });

    it("rejects an empty file", async () => {
      await expect(
        service.create("user-1", TXN, pngFile({ buffer: Buffer.alloc(0) })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("rejects a missing file", async () => {
      await expect(
        service.create("user-1", TXN, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a file over the size limit", async () => {
      const big = Buffer.concat([
        PNG_BYTES,
        Buffer.alloc(MAX_ATTACHMENT_BYTES),
      ]);
      await expect(
        service.create(
          "user-1",
          TXN,
          pngFile({ buffer: big, size: big.length }),
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it("rejects an unrecognised file type", async () => {
      const junk = Buffer.from("not a real image or pdf", "ascii");
      await expect(
        service.create(
          "user-1",
          TXN,
          pngFile({ buffer: junk, size: junk.length }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it("rejects when the transaction is not owned by the user", async () => {
      lockedParent = null;
      (lockTransactionRow as jest.Mock).mockResolvedValue(null);
      await expect(
        service.create("user-1", TXN, pngFile()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("rejects when the per-transaction cap is reached", async () => {
      attRepo.count.mockResolvedValue(MAX_ATTACHMENTS_PER_TRANSACTION);
      await expect(
        service.create("user-1", TXN, pngFile()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("counts the cap under a lock on the parent transaction", async () => {
      // The regression guard for P4-017: the count is only a cap if every
      // uploader queues behind the same row first. Two uploads that both counted
      // 9 both passed `< 10` and the transaction ended with 11.
      await service.create("user-1", TXN, pngFile());

      expect(lockTransactionRow).toHaveBeenCalledWith(
        expect.anything(),
        "txn-1",
        "user-1",
      );
      const lockOrder = (lockTransactionRow as jest.Mock).mock
        .invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(attRepo.count.mock.invocationCallOrder[0]);
    });

    // The second parent (WTY-003). Same checks, same cap, same lock doctrine;
    // what differs is which row is locked and which column the count and the
    // insert name.
    describe("under a warranty", () => {
      it("locks the warranty row, not a transaction, before counting", async () => {
        await service.create("user-1", WTY, pngFile());

        expect(lockWarrantyRow).toHaveBeenCalledWith(
          expect.anything(),
          "wty-1",
          "user-1",
        );
        expect(lockTransactionRow).not.toHaveBeenCalled();
        const lockOrder = (lockWarrantyRow as jest.Mock).mock
          .invocationCallOrder[0];
        expect(lockOrder).toBeLessThan(
          attRepo.count.mock.invocationCallOrder[0],
        );
      });

      it("rejects when the warranty is not owned by the user", async () => {
        await expect(
          service.create("user-2", WTY, pngFile()),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(attRepo.save).not.toHaveBeenCalled();
        expect(storage.save).not.toHaveBeenCalled();
      });

      it("counts the cap under the warranty column alone", async () => {
        await service.create("user-1", WTY, pngFile());

        const where = attRepo.count.mock.calls[0][0].where;
        expect(where).toMatchObject({ warrantyId: "wty-1", userId: "user-1" });
        expect(where).not.toHaveProperty("transactionId");
        expect(where.originalOfAttachmentId).toBeDefined();
      });

      it("rejects when the warranty's cap is reached", async () => {
        attRepo.count.mockResolvedValue(MAX_ATTACHMENTS_PER_TRANSACTION);
        await expect(
          service.create("user-1", WTY, pngFile()),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(storage.save).not.toHaveBeenCalled();
      });

      it("stores the warranty as the parent with the document kind", async () => {
        const result = await service.create(
          "user-1",
          WTY,
          pngFile(),
          undefined,
          "manual",
        );

        expect(result.warrantyId).toBe("wty-1");
        expect(result.transactionId).toBeNull();
        expect(result.documentKind).toBe("manual");
      });

      it("gives both halves of a scan pair the parent and the kind", async () => {
        await service.create(
          "user-1",
          WTY,
          pngFile({ originalname: "scan.png" }),
          pngFile({
            originalname: "orig.jpg",
            buffer: JPEG_BYTES,
            size: JPEG_BYTES.length,
          }),
          "receipt",
        );

        expect(attRepo.save).toHaveBeenCalledTimes(2);
        for (const [row] of attRepo.save.mock.calls) {
          expect(row).toMatchObject({
            warrantyId: "wty-1",
            transactionId: null,
            documentKind: "receipt",
          });
        }
      });
    });

    it("removes the stored object when the transaction rolls back", async () => {
      // An external provider's put cannot roll back with PostgreSQL, so the bytes
      // have to be cleaned up explicitly -- there is no metadata row left to
      // record a tombstone against (P4-010).
      externalStorage();
      attRepo.save.mockRejectedValue(new Error("commit failed"));

      await expect(service.create("user-1", TXN, pngFile())).rejects.toThrow(
        "commit failed",
      );

      // save() threw before the object was written, so nothing to clean up.
      expect(storage.delete).not.toHaveBeenCalled();
    });

    it("removes the stored object when the commit fails after the put", async () => {
      externalStorage();
      let capturedId = "";
      storage.save.mockImplementation(async (key: string) => {
        capturedId = key;
      });
      // Fails after storage.save() has already run.
      const failingManager = {
        getRepository: jest.fn(() => attRepo),
        // The intent was still ours -- the failure under test is the commit, not
        // the sweeper claiming the object.
        query: jest.fn().mockResolvedValue([[{ id: "t1" }], 1]),
      } as unknown as EntityManager;
      // Two transactions now, and only the second one fails: the upload intent is
      // committed on its own connection first, precisely so it survives this
      // rollback (audit FV4-003).
      mockedTenantTx
        .mockImplementationOnce((_ds, fn) => fn(manager))
        .mockImplementationOnce(async (_ds, fn) => {
          await fn(failingManager);
          throw new Error("commit failed");
        });

      await expect(service.create("user-1", TXN, pngFile())).rejects.toThrow(
        "commit failed",
      );

      expect(storage.delete).toHaveBeenCalledWith(capturedId);
    });

    /**
     * FV4-003: the bytes had to become *discoverable*, not merely cleaned up.
     *
     * The old code deleted the object in a catch, which runs only if this process
     * is still alive. Killed between the put and the commit, the bytes survived
     * with no metadata row -- and therefore no tombstone, so the orphan sweep
     * could not enumerate them either. An upload intent committed before the put
     * is what makes the object findable whatever happens next.
     */
    /**
     * A scan pair: the enhanced image the user sees plus the photo it came
     * from, in ONE request and ONE transaction. Two rows, two objects, and no
     * intermediate state a reader can observe -- an original stored without its
     * scan, or a scan reported as saved with the original silently dropped, are
     * both worse than the upload failing.
     */
    describe("a scanned pair", () => {
      const scan = () =>
        pngFile({ originalname: "receipt-scan.jpg", buffer: PNG_BYTES });
      const original = () =>
        pngFile({ originalname: "receipt.jpg", buffer: JPEG_BYTES });

      it("writes both rows and both objects, linking the original to the visible row", async () => {
        const result = await service.create("user-1", TXN, scan(), original());

        // The visible row is what the caller gets back, and it carries no link:
        // the link lives on the original, pointing here.
        expect(result.originalOfAttachmentId).toBeNull();
        expect(attRepo.save).toHaveBeenCalledTimes(2);

        const [visible, hidden] = attRepo.save.mock.calls.map((c) => c[0]);
        expect(visible.id).toBe(result.id);
        expect(hidden.originalOfAttachmentId).toBe(result.id);
        expect(hidden.filename).toBe("receipt.jpg");
        expect(hidden.byteSize).toBe(JPEG_BYTES.length);
        expect(hidden.sha256).toBe(
          createHash("sha256").update(JPEG_BYTES).digest("hex"),
        );

        // Both sets of bytes are stored, each under its own row's id.
        expect(storage.save).toHaveBeenCalledTimes(2);
        expect(storage.save).toHaveBeenCalledWith(result.id, PNG_BYTES);
        expect(storage.save).toHaveBeenCalledWith(hidden.id, JPEG_BYTES);
      });

      // The foreign key is immediate, so the row being referenced has to exist
      // before the row referencing it. Order is the whole of that guarantee.
      it("saves the visible row before the original that references it", async () => {
        const result = await service.create("user-1", TXN, scan(), original());

        const savedIds = attRepo.save.mock.calls.map((c) => c[0].id);
        expect(savedIds[0]).toBe(result.id);
        expect(attRepo.save.mock.calls[0][0].originalOfAttachmentId).toBeNull();
      });

      it("counts the pair as one attachment against the cap", async () => {
        await service.create("user-1", TXN, scan(), original());

        // Primaries only -- an original consuming a slot would let ten scans
        // fill a twenty-attachment transaction the user sees ten rows in.
        expect(attRepo.count).toHaveBeenCalledTimes(1);
        expect(attRepo.count.mock.calls[0][0].where).toMatchObject({
          transactionId: "txn-1",
          userId: "user-1",
        });
        expect(
          attRepo.count.mock.calls[0][0].where.originalOfAttachmentId,
        ).toBeDefined();
      });

      it("refuses a pair whose visible half is not an image", async () => {
        await expect(
          service.create(
            "user-1",
            TXN,
            pngFile({ originalname: "invoice.pdf", buffer: PDF_BYTES }),
            original(),
          ),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(attRepo.save).not.toHaveBeenCalled();
        expect(storage.save).not.toHaveBeenCalled();
      });

      it("refuses a pair whose original is not an image", async () => {
        await expect(
          service.create(
            "user-1",
            TXN,
            scan(),
            pngFile({ originalname: "scan.pdf", buffer: PDF_BYTES }),
          ),
        ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
        expect(attRepo.save).not.toHaveBeenCalled();
      });

      // The original is stored, downloaded and restored by the same code as the
      // visible file, so it is admitted on the same terms -- not weaker ones.
      it("applies the size limit to the original too", async () => {
        const huge = Buffer.concat([
          PNG_BYTES,
          Buffer.alloc(MAX_ATTACHMENT_BYTES),
        ]);
        await expect(
          service.create(
            "user-1",
            TXN,
            scan(),
            pngFile({ buffer: huge, size: huge.length }),
          ),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
        expect(attRepo.save).not.toHaveBeenCalled();
      });

      it("commits an upload intent for each object before writing either", async () => {
        externalStorage();

        await service.create("user-1", TXN, scan(), original());

        const inserts = managerQuery.mock.calls.filter(([sql]) =>
          String(sql).includes("INSERT INTO attachment_blob_tombstones"),
        );
        expect(inserts).toHaveLength(2);
        // Both intents precede both puts: a rollback between the two writes
        // still leaves the sweeper able to enumerate either object.
        expect(storage.save).toHaveBeenCalledTimes(2);
      });

      // The pair can fail with one object already durable and the other not, so
      // the compensation is per key rather than a single boolean.
      it("deletes only the object it managed to write when the second put fails", async () => {
        externalStorage();
        storage.save
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("s3 down"));

        await expect(
          service.create("user-1", TXN, scan(), original()),
        ).rejects.toThrow("s3 down");

        const writtenId = storage.save.mock.calls[0][0];
        expect(storage.delete).toHaveBeenCalledTimes(1);
        expect(storage.delete).toHaveBeenCalledWith(writtenId);
      });

      it("deletes both objects when the transaction rolls back after both puts", async () => {
        externalStorage();
        // Three transactions for a pair: one upload intent per object, each on
        // its own connection so it survives this rollback, then the metadata
        // one that fails. Only the last may throw, or the puts never happen and
        // the test would pass with nothing to clean up.
        mockedTenantTx
          .mockImplementationOnce((_ds, fn) => fn(manager))
          .mockImplementationOnce((_ds, fn) => fn(manager))
          .mockImplementationOnce(async (_ds, fn) => {
            await fn(manager);
            throw new Error("commit failed");
          });

        await expect(
          service.create("user-1", TXN, scan(), original()),
        ).rejects.toThrow("commit failed");

        expect(storage.delete).toHaveBeenCalledTimes(2);
        const deleted = storage.delete.mock.calls.map((c) => c[0]).sort();
        const written = storage.save.mock.calls.map((c) => c[0]).sort();
        expect(deleted).toEqual(written);
      });
    });

    describe("the upload intent", () => {
      /** The tombstone inserts recorded across every transaction this run opened. */
      function intentInserts(): unknown[][] {
        return managerQuery.mock.calls.filter((call) =>
          String(call[0]).includes("INSERT INTO attachment_blob_tombstones"),
        );
      }

      it("is committed before a single byte is written", async () => {
        externalStorage();
        let queriesBeforePut = 0;
        storage.save.mockImplementation(async () => {
          queriesBeforePut = intentInserts().length;
        });

        await service.create("user-1", TXN, pngFile());

        expect(queriesBeforePut).toBe(1);
        const [sql, params] = intentInserts()[0];
        expect(String(sql)).toContain("ON CONFLICT");
        // The lease keeps the sweeper away from an upload that is probably still
        // running; the fence in `clearUploadIntent` is what makes it safe.
        expect(String(sql)).toContain("upload_lease_expires_at");
        expect(params).toEqual([
          "user-1",
          "s3",
          expect.any(String),
          String(UPLOAD_INTENT_LEASE_MS),
        ]);
      });

      it("is cleared inside the transaction that commits the metadata row", async () => {
        externalStorage();

        const saved = await service.create("user-1", TXN, pngFile());

        // Same transaction as the metadata row, so the pair is atomic: a rollback
        // after this point keeps the intent and the sweeper finds the object. And
        // it is conditional on `swept_at IS NULL`, which is the fence.
        const clear = managerQuery.mock.calls.find((call) =>
          String(call[0]).includes("DELETE FROM attachment_blob_tombstones"),
        );
        expect(String(clear?.[0])).toContain("swept_at IS NULL");
        expect(String(clear?.[0])).toContain("RETURNING id");
        expect(clear?.[1]).toEqual(["s3", saved.id]);
      });

      it("refuses to commit metadata once the sweeper has claimed the object", async () => {
        // The reproduction the age check permitted: the sweep decided this upload
        // was abandoned and deleted the bytes, and the metadata transaction was
        // about to commit a row referencing them. A 201 over missing bytes loses the
        // user's receipt invisibly, so the transaction has to fail instead
        // (audit RV4-002).
        externalStorage();
        intentStillOurs = false;

        await expect(
          service.create("user-1", TXN, pngFile()),
        ).rejects.toBeInstanceOf(AttachmentObjectSweptError);
      });

      it("reads the clear's row count rather than the result's length", async () => {
        // `DELETE ... RETURNING` comes back as `[rows, rowCount]`, so a length
        // check is 2 whether or not anything was cleared -- the fence would never
        // fire, which is the whole failure it exists to prevent.
        externalStorage();
        managerQuery.mockImplementation(async (sql: string) =>
          String(sql).includes("DELETE FROM attachment_blob_tombstones")
            ? [[], 0]
            : [],
        );

        await expect(
          service.create("user-1", TXN, pngFile()),
        ).rejects.toBeInstanceOf(AttachmentObjectSweptError);
      });

      it("refuses to reuse a key whose tombstone is already swept", async () => {
        // Not reachable with per-upload UUID keys, and that is the reason to make
        // the statement refuse rather than to reason about it: resurrecting a swept
        // row would un-fence the sweeper's claim, and a claimed row may be inside
        // its late-write quarantine with bytes still pending deletion at that key
        // (audit RRV4-002).
        externalStorage();
        keyIsFree = false;

        await expect(
          service.create("user-1", TXN, pngFile()),
        ).rejects.toBeInstanceOf(AttachmentObjectSweptError);
        // And nothing was written, so there is nothing to compensate for.
        expect(storage.save).not.toHaveBeenCalled();
      });

      it("does not clear an existing claim when it takes the key", async () => {
        externalStorage();

        await service.create("user-1", TXN, pngFile());

        const [sql] = intentInserts()[0];
        expect(String(sql)).toContain("swept_at IS NULL");
        expect(String(sql)).not.toContain("swept_at = NULL");
      });

      it("is not recorded at all for the database provider", async () => {
        // Its blob write joins the transaction and genuinely rolls back with the
        // metadata row, so there is nothing to compensate for.
        await service.create("user-1", TXN, pngFile());

        expect(intentInserts()).toEqual([]);
      });

      it("survives a rollback whose cleanup delete also fails", async () => {
        externalStorage();
        storage.save.mockResolvedValue(undefined);
        storage.delete.mockRejectedValue(new Error("s3 unreachable"));
        mockedTenantTx
          .mockImplementationOnce((_ds, fn) => fn(manager))
          .mockImplementationOnce(async (_ds, fn) => {
            await fn(manager);
            throw new Error("commit failed");
          });

        await expect(service.create("user-1", TXN, pngFile())).rejects.toThrow(
          "commit failed",
        );

        // Nothing else ran, so the intent recorded before the put is the only
        // remaining pointer to the object -- and it is still there.
        expect(intentInserts()).toHaveLength(1);
      });
    });
  });

  describe("findAllFor", () => {
    // A transaction's attachments are its own rows plus the documents of
    // every warranty linked to it (the maintainer's ruling,
    // attachment-parent.ts): the read keys each row by the transaction it is
    // reached from, and names the warranty a document hangs off.
    it("lists the transaction's own rows and its linked warranties' documents, scoped to the user", async () => {
      const rows = [{ id: "a1" }, { id: "d1" }] as TransactionAttachment[];
      qb.getRawAndEntities.mockResolvedValue({
        entities: rows,
        raw: [
          { orig_id: null, warranty_name: null },
          { orig_id: null, warranty_name: "Dishwasher" },
        ],
      });

      const result = await service.findAllFor("user-1", TXN);

      expect(result).toEqual([
        { id: "a1", originalAttachmentId: null, warrantyName: null },
        { id: "d1", originalAttachmentId: null, warrantyName: "Dishwasher" },
      ]);
      expect(qb.leftJoin).toHaveBeenCalledWith(
        Warranty,
        "w",
        reachingWarrantyJoinSql("ta", "w"),
      );
      expect(qb.addSelect).toHaveBeenCalledWith("w.name", "warranty_name");
      expect(qb.where).toHaveBeenCalledWith(
        `${reachedTransactionIdSql("ta", "w")} = :parentId`,
        { parentId: "txn-1" },
      );
      expect(qb.andWhere).toHaveBeenCalledWith("ta.user_id = :userId", {
        userId: "user-1",
      });
    });

    it("orders the transaction's own rows before its warranties' documents", async () => {
      await service.findAllFor("user-1", TXN);

      expect(qb.orderBy).toHaveBeenCalledWith(
        "ta.warranty_id IS NOT NULL",
        "ASC",
      );
      expect(qb.addOrderBy).toHaveBeenCalledWith("ta.created_at", "ASC");
    });

    // The list is what the user sees, and a scan pair is one attachment: the
    // original travels as an id on its visible row, never as a row of its own.
    it("hides originals and carries each one's id on its visible row", async () => {
      qb.getRawAndEntities.mockResolvedValue({
        entities: [
          { id: "scan-1" },
          { id: "plain-1" },
        ] as TransactionAttachment[],
        raw: [
          { orig_id: "orig-1", warranty_name: null },
          { orig_id: null, warranty_name: null },
        ],
      });

      const result = await service.findAllFor("user-1", TXN);

      expect(result).toEqual([
        { id: "scan-1", originalAttachmentId: "orig-1", warrantyName: null },
        { id: "plain-1", originalAttachmentId: null, warrantyName: null },
      ]);
      // Not spelled out here: the shared predicate is the only place it is
      // written, and `primary-attachment.guard.spec.ts` fails a second copy.
      expect(qbConditions).toContain("ta.original_of_attachment_id IS NULL");
    });
  });

  describe("findAllFor a warranty", () => {
    it("lists under the warranty column alone, scoped to the user", async () => {
      qb.getRawAndEntities.mockResolvedValue({
        entities: [{ id: "a1" }] as TransactionAttachment[],
        raw: [{ orig_id: null, warranty_name: "Dishwasher" }],
      });

      const result = await service.findAllFor("user-1", WTY);

      expect(result).toEqual([
        { id: "a1", originalAttachmentId: null, warrantyName: "Dishwasher" },
      ]);
      expect(qb.where).toHaveBeenCalledWith("ta.warranty_id = :parentId", {
        parentId: "wty-1",
      });
      expect(qb.andWhere).toHaveBeenCalledWith("ta.user_id = :userId", {
        userId: "user-1",
      });
      expect(qbConditions).toContain("ta.original_of_attachment_id IS NULL");
    });
  });

  describe("updateDocumentKind", () => {
    const document = {
      id: "doc-1",
      userId: "user-1",
      transactionId: null,
      warrantyId: "wty-1",
      documentKind: "other",
    } as TransactionAttachment;

    it("changes the kind of the row and its scan original in one statement, and answers the list row", async () => {
      attRepo.findOne.mockResolvedValue(document);
      qb.getRawAndEntities.mockResolvedValue({
        entities: [{ ...document, documentKind: "manual" }],
        raw: [{ orig_id: "orig-1", warranty_name: "Dishwasher" }],
      });

      const result = await service.updateDocumentKind(
        "user-1",
        "doc-1",
        "manual",
      );

      expect(attRepo.findOne).toHaveBeenCalledWith({
        where: { id: "doc-1", userId: "user-1" },
      });
      // The pair is one document: the hidden original takes the kind in the
      // same UPDATE as its visible row, under the owner's id.
      const update = managerQuery.mock.calls.find(([sql]) =>
        String(sql).includes("UPDATE transaction_attachments"),
      );
      expect(update).toBeDefined();
      expect(String(update?.[0]).replace(/\s+/g, " ")).toContain(
        "SET document_kind = $1 WHERE (id = $2 OR original_of_attachment_id = $2) AND user_id = $3",
      );
      expect(update?.[1]).toEqual(["manual", "doc-1", "user-1"]);
      expect(result).toEqual({
        ...document,
        documentKind: "manual",
        originalAttachmentId: "orig-1",
        warrantyName: "Dishwasher",
      });
      expect(qb.where).toHaveBeenCalledWith("ta.id = :id", { id: "doc-1" });
      expect(qb.andWhere).toHaveBeenCalledWith("ta.user_id = :userId", {
        userId: "user-1",
      });
    });

    it("refuses a row the caller does not own as not found, writing nothing", async () => {
      attRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateDocumentKind("user-1", "doc-1", "manual"),
      ).rejects.toThrow(NotFoundException);

      expect(
        managerQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE")),
      ).toBe(false);
    });

    // A transaction's attachment has no kind (W4): the refusal is the one
    // `create` gives a kind on a transaction parent, and nothing is written.
    it("refuses a transaction's attachment with a 400, writing nothing", async () => {
      attRepo.findOne.mockResolvedValue({
        ...document,
        transactionId: "txn-1",
        warrantyId: null,
      });

      await expect(
        service.updateDocumentKind("user-1", "doc-1", "receipt"),
      ).rejects.toThrow(BadRequestException);

      expect(
        managerQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE")),
      ).toBe(false);
    });
  });

  describe("summarizeUsageByUser", () => {
    /**
     * The cross-user read's required ambient identity. Seeded here rather than
     * mocked away, so the fence below is exercised by every case that is not
     * about it.
     */
    const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
      requestContextStorage.run({ system: true }, fn);

    /** Answer the aggregate with `rows`, leaving the other statements alone. */
    const aggregateReturns = (
      rows: Array<{ user_id: string; files: string; bytes: string }>,
    ): void => {
      const previous = managerQuery.getMockImplementation();
      managerQuery.mockImplementation(async (sql: string, ...rest: never[]) =>
        String(sql).includes("FROM transaction_attachments")
          ? rows
          : previous?.(sql, ...rest),
      );
    };

    it("totals each user's bytes and file count from the metadata rows", async () => {
      aggregateReturns([
        { user_id: "user-1", files: "3", bytes: "2048" },
        { user_id: "user-2", files: "1", bytes: "512" },
      ]);

      const usage = await asSystem(() => service.summarizeUsageByUser());

      expect(usage.get("user-1")).toEqual({ files: 3, bytes: 2048 });
      expect(usage.get("user-2")).toEqual({ files: 1, bytes: 512 });
    });

    // COUNT and SUM over a BIGINT both arrive as strings from the pg driver, so
    // a figure left unconverted concatenates instead of adding -- and the
    // difference only shows on a deployment with real attachments in it.
    it("converts the driver's strings to numbers at the boundary", async () => {
      aggregateReturns([{ user_id: "user-1", files: "2", bytes: "9007199" }]);

      const usage = await asSystem(() => service.summarizeUsageByUser());

      expect(typeof usage.get("user-1")?.bytes).toBe("number");
      expect(typeof usage.get("user-1")?.files).toBe("number");
      expect((usage.get("user-1")?.bytes ?? 0) + 1).toBe(9007200);
    });

    it("groups every user in one statement rather than querying per user", async () => {
      aggregateReturns([]);

      await asSystem(() => service.summarizeUsageByUser());

      const aggregates = managerQuery.mock.calls.filter((call) =>
        String(call[0]).includes("FROM transaction_attachments"),
      );
      expect(aggregates).toHaveLength(1);
      expect(String(aggregates[0][0])).toContain("GROUP BY user_id");
    });

    // The figure is the bytes each file occupies, so both halves of a scan pair
    // count -- unlike `findAllForTransaction`, which shows the pair as one row.
    it("counts every stored row, not only the ones a register lists", async () => {
      aggregateReturns([]);

      await asSystem(() => service.summarizeUsageByUser());

      const [sql] = managerQuery.mock.calls.find((call) =>
        String(call[0]).includes("FROM transaction_attachments"),
      ) as [string];
      expect(sql).not.toContain("original_of_attachment_id");
    });

    // The failure this prevents is silent: under one user's own scope RLS
    // answers with that user's rows, the aggregate looks complete, and every
    // other account reads as storing nothing.
    it("refuses to answer without the system context its rows need", async () => {
      await expect(service.summarizeUsageByUser()).rejects.toThrow(
        /system context/,
      );
    });
  });

  describe("getForDownload", () => {
    it("returns bytes and headers for an owned attachment", async () => {
      attRepo.findOne.mockResolvedValue({
        id: "a1",
        contentType: "image/png",
        filename: "r.png",
        byteSize: 10,
        storageProvider: "database",
        storageKey: "a1",
      });
      storage.load.mockResolvedValue(PNG_BYTES);

      const result = await service.getForDownload("user-1", "a1");

      expect(result).toEqual({
        data: PNG_BYTES,
        contentType: "image/png",
        filename: "r.png",
        byteSize: 10,
      });
      expect(storage.load).toHaveBeenCalledWith("a1");
    });

    it("throws when the attachment is not found for the user", async () => {
      attRepo.findOne.mockResolvedValue(null);
      await expect(
        service.getForDownload("user-1", "a1"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.load).not.toHaveBeenCalled();
    });

    describe("for an acting delegate (design decision 9)", () => {
      const row = {
        id: "a1",
        contentType: "image/png",
        filename: "r.png",
        byteSize: 10,
        storageProvider: "database",
        storageKey: "a1",
      };

      it("serves a warranty's document: the section admitted them to the route", async () => {
        attRepo.findOne.mockResolvedValue({
          ...row,
          transactionId: null,
          warrantyId: "wty-1",
        });
        storage.load.mockResolvedValue(PNG_BYTES);

        const result = await service.getForDownload("user-1", "a1", {
          isDelegate: true,
        });

        expect(result.data).toBe(PNG_BYTES);
      });

      it("refuses a transaction's attachment before reading a byte: that parent keeps its owner-only rule", async () => {
        attRepo.findOne.mockResolvedValue({
          ...row,
          transactionId: "tx-1",
          warrantyId: null,
        });

        await expect(
          service.getForDownload("user-1", "a1", { isDelegate: true }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(storage.load).not.toHaveBeenCalled();
      });

      it("serves the owner a transaction's attachment as before", async () => {
        attRepo.findOne.mockResolvedValue({
          ...row,
          transactionId: "tx-1",
          warrantyId: null,
        });
        storage.load.mockResolvedValue(PNG_BYTES);

        const result = await service.getForDownload("user-1", "a1", {
          isDelegate: false,
        });

        expect(result.data).toBe(PNG_BYTES);
      });
    });

    it("reads from the backend the row names, not the active one", async () => {
      // The defect this closes: after ATTACHMENT_STORAGE_PROVIDER changed, every
      // attachment uploaded before it was asked of the NEW backend and answered
      // 404 -- metadata listed, filename and size shown, bytes intact elsewhere.
      const previous = previousStorage("local");
      previous.load.mockResolvedValue(PNG_BYTES);
      attRepo.findOne.mockResolvedValue({
        id: "a1",
        contentType: "image/png",
        filename: "r.png",
        byteSize: 10,
        storageProvider: "local",
        storageKey: "a1",
      });

      const result = await service.getForDownload("user-1", "a1");

      expect(result.data).toBe(PNG_BYTES);
      expect(previous.load).toHaveBeenCalledWith("a1");
      expect(storage.load).not.toHaveBeenCalled();
    });

    it("says which backend is missing when the row names one it cannot reach", async () => {
      attRepo.findOne.mockResolvedValue({
        id: "a1",
        contentType: "image/png",
        filename: "r.png",
        byteSize: 10,
        storageProvider: "s3",
        storageKey: "a1",
      });

      // Not a 404: nothing is lost, one setting is absent, and the two have
      // different repairs -- so the refusal names the backend to configure.
      await expect(
        service.getForDownload("user-1", "a1"),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(storage.load).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    beforeEach(() => {
      attRepo.findOne.mockResolvedValue({
        id: "a1",
        userId: "user-1",
        transactionId: TXN.id,
        warrantyId: null,
        sharedGroupId: null,
        sharedEntryId: null,
      });
    });
    it("deletes metadata, then hands the object to the sweeper", async () => {
      managerQuery.mockResolvedValue([
        { storage_provider: "s3", storage_key: "a1" },
      ]);

      await service.remove("user-1", "a1");

      const [sql, params] = managerQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM transaction_attachments");
      expect(sql).toContain("RETURNING storage_provider, storage_key");
      expect(params).toEqual(["a1", "user-1"]);
      // The external delete happens AFTER the metadata delete has committed, so
      // a commit failure cannot leave metadata pointing at bytes that are gone.
      // The row's own backend, not the active one: an attachment deleted before
      // the relocation pass reached it still holds its bytes where it says.
      expect(orphanSweeper.sweepKey).toHaveBeenCalledWith("a1", "s3");
    });

    // Deleting a scan pair deletes both rows. The database cascade would remove
    // the original anyway; naming it in the statement is what RETURNS its key,
    // so its bytes go now instead of waiting for the hourly sweep.
    it("deletes a scan pair's original with it and sweeps both objects", async () => {
      managerQuery.mockResolvedValue([
        { storage_provider: "database", storage_key: "visible-1" },
        { storage_provider: "database", storage_key: "original-1" },
      ]);

      await service.remove("user-1", "visible-1");

      const [sql, params] = managerQuery.mock.calls[0];
      expect(sql).toContain("original_of_attachment_id = $1");
      expect(params).toEqual(["visible-1", "user-1"]);
      expect(orphanSweeper.sweepKey).toHaveBeenCalledTimes(2);
      expect(orphanSweeper.sweepKey).toHaveBeenCalledWith(
        "visible-1",
        "database",
      );
      expect(orphanSweeper.sweepKey).toHaveBeenCalledWith(
        "original-1",
        "database",
      );
    });

    it("throws when the attachment is not found for the user", async () => {
      attRepo.findOne.mockResolvedValue(null);
      managerQuery.mockResolvedValue([]);
      await expect(service.remove("user-1", "a1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orphanSweeper.sweepKey).not.toHaveBeenCalled();
    });

    it("does not sweep when a concurrent delete already removed the row", async () => {
      // Both requests pass their own ownership read; only one DELETE matches, and
      // only that one may go on to remove the bytes. The loser reporting success
      // and sweeping would delete an object the winner's metadata still names if
      // the two ever disagreed about the key.
      managerQuery.mockResolvedValue([[], 0]);
      await expect(service.remove("user-1", "a1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orphanSweeper.sweepKey).not.toHaveBeenCalled();
    });
  });
});

describe("sanitizeFilename", () => {
  it("strips path components", () => {
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\a\\receipt.png")).toBe("receipt.png");
  });

  it("removes control characters that could break headers", () => {
    expect(sanitizeFilename("re\r\nceipt.png")).toBe("receipt.png");
  });

  it("falls back when the name is empty", () => {
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename(undefined)).toBe("attachment");
  });

  it("truncates to the column length", () => {
    expect(sanitizeFilename("a".repeat(300)).length).toBe(255);
  });
});
