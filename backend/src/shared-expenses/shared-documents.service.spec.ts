import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { AttachmentsService } from "../attachments/attachments.service";
import { TransactionAttachment } from "../attachments/entities/transaction-attachment.entity";
import {
  authorizedAttachment,
  authorizeSharedAttachmentParent,
  recordSharedDocumentActivity,
} from "../attachments/shared-attachment-access";
import { requireSharedGroup } from "./shared-db";
import {
  SharedDocumentsService,
  SharedDocument,
} from "./shared-documents.service";
import { sharedGroupFixture } from "./__fixtures__/shared-group";

jest.mock("../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("./shared-db", () => ({
  ...jest.requireActual("./shared-db"),
  requireSharedGroup: jest.fn(),
}));
jest.mock("../attachments/shared-attachment-access", () => ({
  authorizedAttachment: jest.fn(),
  authorizeSharedAttachmentParent: jest.fn(),
  recordSharedDocumentActivity: jest.fn(),
}));

describe("Shared file publication and destination validation", () => {
  let query: jest.Mock;
  let create: jest.Mock;
  let download: jest.Mock;
  let service: SharedDocumentsService;
  const document = (patch: Partial<SharedDocument> = {}): SharedDocument => ({
    id: "shared-file",
    uploaderName: "Me",
    filename: "receipt.png",
    contentType: "image/png",
    byteSize: 3,
    documentKind: "receipt",
    documentRevision: 1,
    sharedGroupId: "group",
    sharedEntryId: null,
    entryTitle: null,
    originalAttachmentId: null,
    createdAt: "2026-01-01T00:00:00Z",
    canEdit: true,
    ...patch,
  });
  const attachment = (patch: Partial<TransactionAttachment> = {}) =>
    Object.assign(new TransactionAttachment(), {
      id: "private-file",
      userId: "owner",
      transactionId:
        patch.sharedGroupId || patch.sharedEntryId
          ? null
          : "private-transaction",
      warrantyId: null,
      sharedGroupId: null,
      sharedEntryId: null,
      originalOfAttachmentId: null,
      documentKind: "receipt",
      documentRevision: 1,
      ...patch,
    });
  const dto = {
    operationId: "operation",
    sourceAttachmentId: "private-file",
    includeOriginal: false,
  };
  const update = {
    expectedRevision: 1,
    filename: "receipt.png",
    documentKind: "receipt" as const,
  };
  const mutations = () =>
    query.mock.calls.filter(([sql]) => /^(UPDATE|INSERT|DELETE)/.test(sql));
  beforeEach(() => {
    jest.clearAllMocks();
    query = jest.fn().mockResolvedValue([]);
    create = jest.fn().mockResolvedValue({ id: "shared-file" });
    download = jest.fn().mockResolvedValue({
      filename: "receipt.png",
      contentType: "image/png",
      byteSize: 3,
      data: Buffer.from("abc"),
    });
    jest
      .mocked(withScopedDb)
      .mockImplementation((_s, work) =>
        work({ query } as unknown as EntityManager),
      );
    jest.mocked(requireSharedGroup).mockResolvedValue(sharedGroupFixture());
    jest.mocked(authorizedAttachment).mockResolvedValue(attachment());
    jest.mocked(authorizeSharedAttachmentParent).mockResolvedValue("group");
    service = new SharedDocumentsService(
      {} as DataSource,
      { create, getForDownload: download } as unknown as AttachmentsService,
    );
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([0, 100, 101])(
    "paginates %i visible documents and converts SQL byte sizes at the boundary",
    async (count) => {
      query.mockResolvedValue(
        Array.from({ length: count }, (_, i) => ({
          ...document({ id: String(i) }),
          byteSize: "3",
        })),
      );
      const result = await service.list("owner", "group", 100, undefined, true);
      expect(result.items).toHaveLength(Math.min(count, 100));
      expect(result.nextOffset).toBe(count > 100 ? 200 : null);
      if (count) expect(result.items[0].byteSize).toBe(3);
      expect(query.mock.calls[0][1]).toEqual([
        "group",
        "owner",
        100,
        true,
        true,
        null,
        true,
      ]);
    },
  );
  it("does not offer editing files to a viewer or an archived group", async () => {
    jest
      .mocked(requireSharedGroup)
      .mockResolvedValue(
        sharedGroupFixture({ role: "VIEWER", archivedAt: "2026-01-01" }),
      );
    await service.list("owner", "group", 0, "entry");
    expect(query.mock.calls[0][1]).toEqual([
      "group",
      "owner",
      0,
      false,
      false,
      "entry",
      false,
    ]);
  });
  it.each([undefined, "entry"])(
    "uploads to the selected destination %s with its retry key",
    async (entryId) => {
      query.mockResolvedValue([{ id: "entry" }]);
      jest
        .spyOn(service, "list")
        .mockResolvedValue({ items: [document()], nextOffset: null });
      const file = {
        originalname: "receipt.png",
        size: 3,
        buffer: Buffer.from("abc"),
      };
      expect(
        await service.upload(
          "owner",
          "group",
          entryId,
          { operationId: "operation", documentKind: "receipt" },
          file,
        ),
      ).toEqual(document());
      expect(create).toHaveBeenCalledWith(
        "owner",
        {
          kind: entryId ? "shared-entry" : "shared-group",
          id: entryId ?? "group",
        },
        file,
        undefined,
        "receipt",
        "operation",
      );
    },
  );
  it("refuses an entry in another group before passing bytes to storage", async () => {
    await expect(
      service.upload("owner", "group", "other-entry", {
        operationId: "operation",
        documentKind: "receipt",
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "publishes an independent copy with original opt-in=%s",
    async (includeOriginal) => {
      query.mockResolvedValue([{ id: "original" }]);
      const upload = jest
        .spyOn(service, "upload")
        .mockResolvedValue(document());
      expect(
        await service.publish("owner", "group", { ...dto, includeOriginal }),
      ).toEqual(document());
      expect(download).toHaveBeenCalledTimes(includeOriginal ? 2 : 1);
      expect(download).toHaveBeenNthCalledWith(1, "owner", "private-file");
      if (includeOriginal)
        expect(download).toHaveBeenNthCalledWith(2, "owner", "original");
      expect(upload).toHaveBeenCalledWith(
        "owner",
        "group",
        undefined,
        { operationId: "operation", documentKind: "receipt" },
        { originalname: "receipt.png", buffer: Buffer.from("abc"), size: 3 },
        includeOriginal
          ? { originalname: "receipt.png", buffer: Buffer.from("abc"), size: 3 }
          : undefined,
      );
      expect(mutations()).toEqual([]);
    },
  );
  it.each([
    { userId: "other" },
    { sharedGroupId: "group" },
    { sharedEntryId: "entry" },
    { originalOfAttachmentId: "scan" },
  ])(
    "refuses republishing an inaccessible/shared/original source: %j",
    async (patch) => {
      jest.mocked(authorizedAttachment).mockResolvedValue(attachment(patch));
      await expect(service.publish("owner", "group", dto)).rejects.toThrow();
      expect(download).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("leaves the private document intact when its download fails", async () => {
    download.mockRejectedValue(new Error("storage unavailable"));
    await expect(service.publish("owner", "group", dto)).rejects.toThrow(
      "storage unavailable",
    );
    expect(mutations()).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["wrong-group", "original", "revision"])(
    "refuses a %s edit before mutating a document",
    async (kind) => {
      jest.mocked(authorizedAttachment).mockResolvedValue(
        attachment({
          sharedGroupId: kind === "wrong-group" ? "elsewhere" : "group",
          originalOfAttachmentId: kind === "original" ? "scan" : null,
          documentRevision: kind === "revision" ? 2 : 1,
        }),
      );
      await expect(
        service.update("owner", "group", "shared-file", update),
      ).rejects.toThrow();
      expect(mutations()).toEqual([]);
    },
  );
  it("refuses moving a document across groups before changing either parent", async () => {
    jest
      .mocked(authorizedAttachment)
      .mockResolvedValue(attachment({ sharedGroupId: "group" }));
    jest
      .mocked(authorizeSharedAttachmentParent)
      .mockResolvedValue("other-group");
    await expect(
      service.update("owner", "group", "shared-file", {
        ...update,
        entryId: "other-entry",
      }),
    ).rejects.toThrow();
    expect(mutations()).toEqual([]);
  });
  it.each([10, 11])(
    "refuses a destination holding %i entry documents",
    async (count) => {
      jest
        .mocked(authorizedAttachment)
        .mockResolvedValue(attachment({ sharedGroupId: "group" }));
      query.mockResolvedValue([{ count }]);
      await expect(
        service.update("owner", "group", "shared-file", {
          ...update,
          entryId: "entry",
        }),
      ).rejects.toThrow();
      expect(mutations()).toEqual([]);
    },
  );
  it("moves the scan and original together, with the expected revision", async () => {
    jest
      .mocked(authorizedAttachment)
      .mockResolvedValue(attachment({ sharedEntryId: "entry" }));
    query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT group_id")) return [{ group_id: "group" }];
      if (sql.startsWith("SELECT count")) return [{ count: 49 }];
      if (sql.includes("RETURNING id")) return [[{ id: "shared-file" }], 1];
      return [];
    });
    expect(
      await service.update("owner", "group", "shared-file", {
        ...update,
        entryId: null,
      }),
    ).toEqual({ id: "shared-file", documentRevision: 2 });
    expect(mutations()).toHaveLength(2);
    expect(mutations()[0][1]).toEqual([
      "shared-file",
      1,
      "receipt.png",
      "receipt",
      "group",
      null,
    ]);
    expect(mutations()[1][0]).toContain("original_of_attachment_id = $1");
    expect(recordSharedDocumentActivity).toHaveBeenCalledWith(
      expect.anything(),
      "owner",
      { kind: "shared-group", id: "group" },
      "DOCUMENT_UPDATED",
      { id: "shared-file", filename: "receipt.png" },
    );
  });
  it("leaves the original and activity untouched if a competing revision wins", async () => {
    jest
      .mocked(authorizedAttachment)
      .mockResolvedValue(attachment({ sharedGroupId: "group" }));
    query.mockResolvedValue([[], 0]);
    await expect(
      service.update("owner", "group", "shared-file", update),
    ).rejects.toMatchObject({ status: 409 });
    expect(mutations()).toHaveLength(1);
    expect(recordSharedDocumentActivity).not.toHaveBeenCalled();
  });
});
