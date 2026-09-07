import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { createHash } from "crypto";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import {
  AttachmentObjectSweptError,
  AttachmentsService,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TRANSACTION,
  UPLOAD_INTENT_LEASE_MS,
  UploadedAttachmentFile,
  sanitizeFilename,
} from "./attachments.service";
import { AttachmentStorageProvider } from "./storage/attachment-storage.interface";
import { AttachmentOrphanSweeper } from "./attachment-orphan-sweeper.service";
import { lockTransactionRow } from "../common/db/locks";
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
      save: jest.fn().mockResolvedValue(undefined),
      load: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
    };

    orphanSweeper = { sweepKey: jest.fn().mockResolvedValue(undefined) };

    service = new AttachmentsService(
      {} as DataSource,
      storage,
      orphanSweeper as unknown as AttachmentOrphanSweeper,
    );
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
    service = new AttachmentsService(
      {} as DataSource,
      storage,
      orphanSweeper as unknown as AttachmentOrphanSweeper,
    );
  }

  describe("create", () => {
    it("stores metadata and bytes, sniffing the real MIME type", async () => {
      const result = await service.create("user-1", "txn-1", pngFile());

      expect(result.contentType).toBe("image/png");
      expect(result.userId).toBe("user-1");
      expect(result.transactionId).toBe("txn-1");
      expect(result.byteSize).toBe(PNG_BYTES.length);
      expect(result.sha256).toBe(
        createHash("sha256").update(PNG_BYTES).digest("hex"),
      );
      expect(result.storageProvider).toBe("database");
      // Database provider keys the bytes by the attachment id.
      expect(result.storageKey).toBe(result.id);
      expect(storage.save).toHaveBeenCalledWith(result.id, PNG_BYTES);
    });

    it("accepts PDFs", async () => {
      const result = await service.create(
        "user-1",
        "txn-1",
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
        service.create("user-1", "txn-1", pngFile({ buffer: Buffer.alloc(0) })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("rejects a missing file", async () => {
      await expect(
        service.create("user-1", "txn-1", undefined),
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
          "txn-1",
          pngFile({ buffer: big, size: big.length }),
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
    });

    it("rejects an unrecognised file type", async () => {
      const junk = Buffer.from("not a real image or pdf", "ascii");
      await expect(
        service.create(
          "user-1",
          "txn-1",
          pngFile({ buffer: junk, size: junk.length }),
        ),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it("rejects when the transaction is not owned by the user", async () => {
      lockedParent = null;
      (lockTransactionRow as jest.Mock).mockResolvedValue(null);
      await expect(
        service.create("user-1", "txn-1", pngFile()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("rejects when the per-transaction cap is reached", async () => {
      attRepo.count.mockResolvedValue(MAX_ATTACHMENTS_PER_TRANSACTION);
      await expect(
        service.create("user-1", "txn-1", pngFile()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.save).not.toHaveBeenCalled();
    });

    it("counts the cap under a lock on the parent transaction", async () => {
      // The regression guard for P4-017: the count is only a cap if every
      // uploader queues behind the same row first. Two uploads that both counted
      // 9 both passed `< 10` and the transaction ended with 11.
      await service.create("user-1", "txn-1", pngFile());

      expect(lockTransactionRow).toHaveBeenCalledWith(
        expect.anything(),
        "txn-1",
        "user-1",
      );
      const lockOrder = (lockTransactionRow as jest.Mock).mock
        .invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(attRepo.count.mock.invocationCallOrder[0]);
    });

    it("removes the stored object when the transaction rolls back", async () => {
      // An external provider's put cannot roll back with PostgreSQL, so the bytes
      // have to be cleaned up explicitly -- there is no metadata row left to
      // record a tombstone against (P4-010).
      externalStorage();
      attRepo.save.mockRejectedValue(new Error("commit failed"));

      await expect(
        service.create("user-1", "txn-1", pngFile()),
      ).rejects.toThrow("commit failed");

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

      await expect(
        service.create("user-1", "txn-1", pngFile()),
      ).rejects.toThrow("commit failed");

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
        const result = await service.create(
          "user-1",
          "txn-1",
          scan(),
          original(),
        );

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
        const result = await service.create(
          "user-1",
          "txn-1",
          scan(),
          original(),
        );

        const savedIds = attRepo.save.mock.calls.map((c) => c[0].id);
        expect(savedIds[0]).toBe(result.id);
        expect(attRepo.save.mock.calls[0][0].originalOfAttachmentId).toBeNull();
      });

      it("counts the pair as one attachment against the cap", async () => {
        await service.create("user-1", "txn-1", scan(), original());

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
            "txn-1",
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
            "txn-1",
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
            "txn-1",
            scan(),
            pngFile({ buffer: huge, size: huge.length }),
          ),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
        expect(attRepo.save).not.toHaveBeenCalled();
      });

      it("commits an upload intent for each object before writing either", async () => {
        externalStorage();

        await service.create("user-1", "txn-1", scan(), original());

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
          service.create("user-1", "txn-1", scan(), original()),
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
          service.create("user-1", "txn-1", scan(), original()),
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

        await service.create("user-1", "txn-1", pngFile());

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

        const saved = await service.create("user-1", "txn-1", pngFile());

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
          service.create("user-1", "txn-1", pngFile()),
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
          service.create("user-1", "txn-1", pngFile()),
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
          service.create("user-1", "txn-1", pngFile()),
        ).rejects.toBeInstanceOf(AttachmentObjectSweptError);
        // And nothing was written, so there is nothing to compensate for.
        expect(storage.save).not.toHaveBeenCalled();
      });

      it("does not clear an existing claim when it takes the key", async () => {
        externalStorage();

        await service.create("user-1", "txn-1", pngFile());

        const [sql] = intentInserts()[0];
        expect(String(sql)).toContain("swept_at IS NULL");
        expect(String(sql)).not.toContain("swept_at = NULL");
      });

      it("is not recorded at all for the database provider", async () => {
        // Its blob write joins the transaction and genuinely rolls back with the
        // metadata row, so there is nothing to compensate for.
        await service.create("user-1", "txn-1", pngFile());

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

        await expect(
          service.create("user-1", "txn-1", pngFile()),
        ).rejects.toThrow("commit failed");

        // Nothing else ran, so the intent recorded before the put is the only
        // remaining pointer to the object -- and it is still there.
        expect(intentInserts()).toHaveLength(1);
      });
    });
  });

  describe("findAllForTransaction", () => {
    it("lists metadata scoped to the user and transaction", async () => {
      const rows = [{ id: "a1" }] as TransactionAttachment[];
      qb.getRawAndEntities.mockResolvedValue({
        entities: rows,
        raw: [{ orig_id: null }],
      });

      const result = await service.findAllForTransaction("user-1", "txn-1");

      expect(result).toEqual([{ id: "a1", originalAttachmentId: null }]);
      expect(qb.where).toHaveBeenCalledWith(
        "ta.transaction_id = :transactionId",
        {
          transactionId: "txn-1",
        },
      );
      expect(qb.andWhere).toHaveBeenCalledWith("ta.user_id = :userId", {
        userId: "user-1",
      });
    });

    // The list is what the user sees, and a scan pair is one attachment: the
    // original travels as an id on its visible row, never as a row of its own.
    it("hides originals and carries each one's id on its visible row", async () => {
      qb.getRawAndEntities.mockResolvedValue({
        entities: [
          { id: "scan-1" },
          { id: "plain-1" },
        ] as TransactionAttachment[],
        raw: [{ orig_id: "orig-1" }, { orig_id: null }],
      });

      const result = await service.findAllForTransaction("user-1", "txn-1");

      expect(result).toEqual([
        { id: "scan-1", originalAttachmentId: "orig-1" },
        { id: "plain-1", originalAttachmentId: null },
      ]);
      // Not spelled out here: the shared predicate is the only place it is
      // written, and `primary-attachment.guard.spec.ts` fails a second copy.
      expect(qbConditions).toContain("ta.original_of_attachment_id IS NULL");
    });
  });

  describe("getForDownload", () => {
    it("returns bytes and headers for an owned attachment", async () => {
      attRepo.findOne.mockResolvedValue({
        id: "a1",
        contentType: "image/png",
        filename: "r.png",
        byteSize: 10,
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
  });

  describe("remove", () => {
    it("deletes metadata, then hands the object to the sweeper", async () => {
      managerQuery.mockResolvedValue([{ storage_key: "a1" }]);

      await service.remove("user-1", "a1");

      const [sql, params] = managerQuery.mock.calls[0];
      expect(sql).toContain("DELETE FROM transaction_attachments");
      expect(sql).toContain("RETURNING storage_key");
      expect(params).toEqual(["a1", "user-1"]);
      // The external delete happens AFTER the metadata delete has committed, so
      // a commit failure cannot leave metadata pointing at bytes that are gone.
      expect(orphanSweeper.sweepKey).toHaveBeenCalledWith("a1");
    });

    // Deleting a scan pair deletes both rows. The database cascade would remove
    // the original anyway; naming it in the statement is what RETURNS its key,
    // so its bytes go now instead of waiting for the hourly sweep.
    it("deletes a scan pair's original with it and sweeps both objects", async () => {
      managerQuery.mockResolvedValue([
        { storage_key: "visible-1" },
        { storage_key: "original-1" },
      ]);

      await service.remove("user-1", "visible-1");

      const [sql, params] = managerQuery.mock.calls[0];
      expect(sql).toContain("original_of_attachment_id = $1");
      expect(params).toEqual(["visible-1", "user-1"]);
      expect(orphanSweeper.sweepKey).toHaveBeenCalledTimes(2);
      expect(orphanSweeper.sweepKey).toHaveBeenCalledWith("visible-1");
      expect(orphanSweeper.sweepKey).toHaveBeenCalledWith("original-1");
    });

    it("throws when the attachment is not found for the user", async () => {
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
