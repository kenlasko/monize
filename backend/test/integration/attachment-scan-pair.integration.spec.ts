import { DataSource } from "typeorm";
import { BadRequestException } from "@nestjs/common";

import {
  AttachmentsService,
  MAX_ATTACHMENTS_PER_TRANSACTION,
  UploadedAttachmentFile,
} from "@/attachments/attachments.service";
import { AttachmentOrphanSweeper } from "@/attachments/attachment-orphan-sweeper.service";
import type { AttachmentStorageProvider } from "@/attachments/storage/attachment-storage.interface";
import { withUserContext } from "@/common/db/with-context";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * A scanned document is stored as two rows -- the enhanced image the user sees
 * and the original photo it came from -- and the claim the feature rests on is
 * that the pair behaves as ONE attachment
 * (`docs/future-plans/document-scanner.md`, INV-ATTACHMENT-002).
 *
 * Four of the five things that make that true are properties of the database,
 * not of the service: the `ON DELETE CASCADE` that takes the original with its
 * visible row, the partial unique index that admits one original per
 * attachment, the CHECK that stops a row being its own original, and the
 * ordering the immediate foreign key imposes on the two inserts. A unit spec
 * mocks the manager, so it can assert the SQL and not one of those outcomes --
 * the pair could be written in the wrong order, or with no constraint behind
 * it, with every mock-based test still green.
 *
 * So this suite runs the real service against a real PostgreSQL, and asks what
 * the tables hold afterwards.
 */
describe("a scanned attachment and the original it came from", () => {
  let dataSource: DataSource;
  let service: AttachmentsService;
  let sweeper: AttachmentOrphanSweeper;
  let objects: Map<string, Buffer>;
  let storage: AttachmentStorageProvider;
  let userId: string;
  let transactionId: string;

  // Two image types, so the halves of a pair are distinguishable by bytes: a
  // service that stored one buffer twice would pass assertions written against
  // a single fixture.
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
  ]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  const PDF = Buffer.from("%PDF-1.7\n...", "ascii");

  const upload = (name: string, buffer: Buffer): UploadedAttachmentFile => ({
    originalname: name,
    buffer,
    size: buffer.length,
  });

  const create = (
    file: UploadedAttachmentFile,
    original?: UploadedAttachmentFile,
  ) =>
    withUserContext(userId, () =>
      service.create(userId, transactionId, file, original),
    );

  const rows = (): Promise<
    {
      id: string;
      filename: string;
      byte_size: string;
      original_of_attachment_id: string | null;
    }[]
  > =>
    dataSource.query(
      `SELECT id, filename, byte_size, original_of_attachment_id
         FROM transaction_attachments
        WHERE transaction_id = $1
        ORDER BY filename`,
      [transactionId],
    );

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "attachment_blob_tombstones",
      "transaction_attachments",
      "transactions",
      "accounts",
      "currencies",
      "users",
    ]);
    objects = new Map();
    storage = {
      // An external provider: its writes cannot join a PostgreSQL transaction,
      // which is the harder of the two shapes for the pair to get right.
      name: "s3",
      save: async (key: string, data: Buffer) => {
        objects.set(key, data);
      },
      load: async (key: string) => {
        const found = objects.get(key);
        if (!found) throw new Error(`no object at ${key}`);
        return found;
      },
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    sweeper = new AttachmentOrphanSweeper(dataSource, storage);
    service = new AttachmentsService(dataSource, storage, sweeper);

    userId = (
      await createTestUserDirect(dataSource, { email: "scanner@example.com" })
    ).id;
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol) VALUES ('USD','US Dollar','$')
       ON CONFLICT DO NOTHING`,
    );
    const [account] = await dataSource.query(
      `INSERT INTO accounts (user_id, name, account_type, currency_code,
                             current_balance, opening_balance)
       VALUES ($1, 'Chequing', 'CHEQUING', 'USD', 0, 0) RETURNING id`,
      [userId],
    );
    const [txn] = await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, amount, transaction_date,
                                 currency_code)
       VALUES ($1, $2, -25, '2026-03-01', 'USD') RETURNING id`,
      [userId, account.id],
    );
    transactionId = txn.id;
  });

  it("stores both halves, linked, with each one's own bytes", async () => {
    const visible = await create(
      upload("receipt-scan.jpg", PNG),
      upload("receipt.jpg", JPEG),
    );

    const stored = await rows();
    expect(stored).toHaveLength(2);

    const original = stored.find((r) => r.filename === "receipt.jpg")!;
    const scan = stored.find((r) => r.filename === "receipt-scan.jpg")!;
    expect(scan.id).toBe(visible.id);
    // The link lives on the original and points at what the user sees.
    expect(scan.original_of_attachment_id).toBeNull();
    expect(original.original_of_attachment_id).toBe(visible.id);

    // Two distinct objects, each carrying its own file rather than one buffer
    // written twice.
    expect(objects.get(scan.id)).toEqual(PNG);
    expect(objects.get(original.id)).toEqual(JPEG);
    expect(Number(original.byte_size)).toBe(JPEG.length);
  });

  it("hides the original from the list and names it on the visible row", async () => {
    const visible = await create(
      upload("receipt-scan.jpg", PNG),
      upload("receipt.jpg", JPEG),
    );
    await create(upload("plain.png", PNG));

    const listed = await withUserContext(userId, () =>
      service.findAllForTransaction(userId, transactionId),
    );

    expect(listed).toHaveLength(2);
    const scanned = listed.find((a) => a.id === visible.id)!;
    expect(scanned.originalAttachmentId).not.toBeNull();
    expect(
      listed.find((a) => a.filename === "plain.png")!.originalAttachmentId,
    ).toBeNull();
    // Three rows exist -- the pair plus the plain upload; the user has two
    // attachments.
    expect(await rows()).toHaveLength(3);
  });

  it("deletes the original with the visible row, and both sets of bytes", async () => {
    const visible = await create(
      upload("receipt-scan.jpg", PNG),
      upload("receipt.jpg", JPEG),
    );
    const originalId = (await rows()).find(
      (r) => r.original_of_attachment_id === visible.id,
    )!.id;
    expect(objects.size).toBe(2);

    await withUserContext(userId, () => service.remove(userId, visible.id));

    // The cascade is the mechanism, and the delete naming the original is what
    // returns its key -- so the bytes go now, not on the next hourly sweep.
    expect(await rows()).toEqual([]);
    expect(objects.has(visible.id)).toBe(false);
    expect(objects.has(originalId)).toBe(false);
  });

  it("counts a pair as one attachment against the per-transaction cap", async () => {
    for (let i = 0; i < MAX_ATTACHMENTS_PER_TRANSACTION; i++) {
      await create(upload(`scan-${i}.jpg`, PNG), upload(`orig-${i}.jpg`, JPEG));
    }

    // Twenty rows, ten attachments: the cap counts what the user can see.
    expect(await rows()).toHaveLength(MAX_ATTACHMENTS_PER_TRANSACTION * 2);
    await expect(
      create(upload("one-too-many.png", PNG)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a pair whose halves are not both images, writing nothing", async () => {
    await expect(
      create(upload("invoice.pdf", PDF), upload("receipt.jpg", JPEG)),
    ).rejects.toThrow();

    // A rejected command must not already have written -- neither row, and
    // neither object.
    expect(await rows()).toEqual([]);
    expect(objects.size).toBe(0);
  });

  describe("the constraints behind the pair", () => {
    it("admits at most one original per attachment", async () => {
      const visible = await create(
        upload("receipt-scan.jpg", PNG),
        upload("receipt.jpg", JPEG),
      );

      await expect(
        dataSource.query(
          `INSERT INTO transaction_attachments
             (user_id, transaction_id, filename, content_type, byte_size,
              sha256, storage_provider, storage_key, original_of_attachment_id)
           VALUES ($1, $2, 'second-original.jpg', 'image/jpeg', 8, $3, 's3',
                   'k-second', $4)`,
          [userId, transactionId, "b".repeat(64), visible.id],
        ),
      ).rejects.toThrow(/uq_transaction_attachments_original_of/);
    });

    it("refuses a row that is its own original", async () => {
      const visible = await create(upload("plain.png", PNG));

      await expect(
        dataSource.query(
          `UPDATE transaction_attachments
              SET original_of_attachment_id = id WHERE id = $1`,
          [visible.id],
        ),
      ).rejects.toThrow(/chk_attachment_not_own_original/);
    });

    it("removes the pair when the parent transaction is deleted", async () => {
      await create(
        upload("receipt-scan.jpg", PNG),
        upload("receipt.jpg", JPEG),
      );

      await dataSource.query(`DELETE FROM transactions WHERE id = $1`, [
        transactionId,
      ]);

      // Both rows go through the transaction's own cascade, with no application
      // code involved -- which is the point of putting the link in the schema.
      expect(await rows()).toEqual([]);
    });
  });
});
