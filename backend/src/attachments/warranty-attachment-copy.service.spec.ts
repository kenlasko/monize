import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { AttachmentsService } from "./attachments.service";
import { TransactionAttachment } from "./entities/transaction-attachment.entity";
import { authorizedAttachment } from "./shared-attachment-access";
import { WarrantyAttachmentCopyService } from "./warranty-attachment-copy.service";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-attachment-access", () => ({
  authorizedAttachment: jest.fn(),
}));

describe("WarrantyAttachmentCopyService", () => {
  let query: jest.Mock;
  let sameFile: { id: string }[];
  let originals: { id: string }[];
  let create: jest.Mock;
  let getForDownload: jest.Mock;
  let service: WarrantyAttachmentCopyService;

  const attachment = (patch: Partial<TransactionAttachment> = {}) =>
    Object.assign(new TransactionAttachment(), {
      id: "receipt",
      userId: "owner",
      transactionId: "purchase",
      warrantyId: null,
      sharedGroupId: null,
      sharedEntryId: null,
      originalOfAttachmentId: null,
      documentKind: "other",
      sha256: "abc",
      ...patch,
    });
  const download = (filename: string, bytes: string) => ({
    data: Buffer.from(bytes),
    filename,
    byteSize: bytes.length,
    contentType: "image/png",
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // The same-file lookup and the scan-original lookup, told apart by SQL.
    sameFile = [];
    originals = [];
    query = jest.fn((sql: string) =>
      Promise.resolve(sql.includes("sha256") ? sameFile : originals),
    );
    create = jest.fn().mockResolvedValue({ id: "copy" });
    getForDownload = jest
      .fn()
      .mockResolvedValue(download("receipt.png", "png"));
    (withScopedDb as jest.Mock).mockImplementation(
      (_dataSource: DataSource, fn: (m: EntityManager) => unknown) =>
        fn({ query } as unknown as EntityManager),
    );
    (authorizedAttachment as jest.Mock).mockResolvedValue(attachment());
    service = new WarrantyAttachmentCopyService(
      {} as DataSource,
      {
        create,
        getForDownload,
      } as unknown as AttachmentsService,
    );
  });

  it("writes a new warranty document from the source's bytes, leaving the source alone", async () => {
    const result = await service.copyToWarranty("owner", "warranty", {
      sourceAttachmentId: "receipt",
      documentKind: "receipt",
      operationId: "op",
    });
    expect(result).toEqual({ id: "copy" });
    expect(create).toHaveBeenCalledWith(
      "owner",
      { kind: "warranty", id: "warranty" },
      { originalname: "receipt.png", buffer: Buffer.from("png"), size: 3 },
      undefined,
      "receipt",
      "op",
      expect.any(Function),
    );
    // A read and a copy: nothing about the source row is written.
    expect(
      query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql)),
    ).toEqual([]);
  });

  it("keeps the source's kind when none is asked for", async () => {
    (authorizedAttachment as jest.Mock).mockResolvedValue(
      attachment({
        transactionId: null,
        warrantyId: "other",
        documentKind: "manual",
      }),
    );
    await service.copyToWarranty("owner", "warranty", {
      sourceAttachmentId: "receipt",
    });
    expect(create.mock.calls[0][4]).toBe("manual");
  });

  it("carries a scan's original with it, as one pair", async () => {
    originals = [{ id: "scan-original" }];
    getForDownload.mockImplementation((_user: string, id: string) =>
      Promise.resolve(
        id === "scan-original"
          ? download("photo.jpg", "jpeg!")
          : download("scan.png", "png"),
      ),
    );
    await service.copyToWarranty("owner", "warranty", {
      sourceAttachmentId: "receipt",
    });
    expect(
      query.mock.calls.find(([sql]) =>
        sql.includes("original_of_attachment_id = "),
      )?.[1],
    ).toEqual(["receipt", "owner"]);
    expect(create.mock.calls[0][3]).toEqual({
      originalname: "photo.jpg",
      buffer: Buffer.from("jpeg!"),
      size: 5,
    });
  });

  it.each([
    ["another user's", { userId: "someone-else" }],
    ["a shared group's", { sharedGroupId: "group", transactionId: null }],
    ["a shared entry's", { sharedEntryId: "entry", transactionId: null }],
    ["a scan's hidden original", { originalOfAttachmentId: "scan" }],
  ])("refuses %s document before reading any bytes", async (_label, patch) => {
    (authorizedAttachment as jest.Mock).mockResolvedValue(attachment(patch));
    await expect(
      service.copyToWarranty("owner", "warranty", {
        sourceAttachmentId: "receipt",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(getForDownload).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a document already on this warranty", async () => {
    (authorizedAttachment as jest.Mock).mockResolvedValue(
      attachment({ transactionId: null, warrantyId: "warranty" }),
    );
    await expect(
      service.copyToWarranty("owner", "warranty", {
        sourceAttachmentId: "receipt",
      }),
    ).rejects.toThrow("already on this warranty");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses the same file copied onto this warranty before", async () => {
    sameFile = [{ id: "earlier-copy" }];
    await expect(
      service.copyToWarranty("owner", "warranty", {
        sourceAttachmentId: "receipt",
      }),
    ).rejects.toThrow("already on this warranty");
    expect(query.mock.calls[0][1]).toEqual(["warranty", "owner", "abc"]);
    expect(create).not.toHaveBeenCalled();
  });

  describe("inside the write's transaction", () => {
    const precondition = async () => {
      await service.copyToWarranty("owner", "warranty", {
        sourceAttachmentId: "receipt",
      });
      return create.mock.calls[0][6] as (m: EntityManager) => Promise<void>;
    };
    const manager = () => ({ query }) as unknown as EntityManager;

    it("passes when the source is as it was", async () => {
      const check = await precondition();
      await expect(check(manager())).resolves.toBeUndefined();
    });

    it("refuses a source moved into a shared group while its bytes were read", async () => {
      const check = await precondition();
      (authorizedAttachment as jest.Mock).mockResolvedValue(
        attachment({ sharedGroupId: "group", transactionId: null }),
      );
      await expect(check(manager())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it("refuses a copy that landed meanwhile", async () => {
      const check = await precondition();
      sameFile = [{ id: "concurrent-copy" }];
      await expect(check(manager())).rejects.toThrow(
        "already on this warranty",
      );
    });

    it("refuses a source whose file changed", async () => {
      const check = await precondition();
      (authorizedAttachment as jest.Mock).mockResolvedValue(
        attachment({ sha256: "different" }),
      );
      await expect(check(manager())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it("passes a missing source through as not found", async () => {
    (authorizedAttachment as jest.Mock).mockRejectedValue(
      new NotFoundException("Attachment not found"),
    );
    await expect(
      service.copyToWarranty("owner", "warranty", {
        sourceAttachmentId: "gone",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(create).not.toHaveBeenCalled();
  });
});
