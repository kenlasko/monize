import { SharedFinanceController } from "./shared-finance.controller";
import { SharedEntryFinanceController } from "./shared-entry-finance.controller";
import { SharedDocumentsController } from "./shared-documents.controller";
import { SharedReviewController } from "./shared-review.controller";
import { SharedFinanceService } from "./shared-finance.service";
import { SharedEntryFinanceService } from "./shared-entry-finance.service";
import { SharedDocumentsService } from "./shared-documents.service";
import { SharedReviewService } from "./shared-review.service";
import type { SaveSharedEntryFinanceDto } from "./dto/shared-entry-finance.dto";

const command = { operationId: "operation", expectedRevision: 4 };
const request = { user: { id: "jwt-owner" } };
const mocks = (...names: string[]): Record<string, jest.Mock> =>
  Object.fromEntries(
    names.map((name) => [name, jest.fn().mockResolvedValue({ id: "result" })]),
  );

describe("Private booking and publication controller boundaries", () => {
  it("preserves explicit preview/commit/unlink commands and never selects a different owner", async () => {
    const finance = mocks("overview", "enable", "preview", "book", "unlink");
    const controller = new SharedFinanceController(
      finance as unknown as SharedFinanceService,
    );
    const input = {
      ...command,
      bankTransactionId: "bank",
      sharedBankAmount: "300.0000",
      sourceSplits: [{ splitId: "split", amount: "300.0000" }],
      previewFingerprint: "a".repeat(64),
    };
    const enable = { ...command, accountName: "Trip settlements" };
    await controller.overview(request, "group");
    await controller.enable(request, "group", enable);
    await controller.preview(request, "group", "entry", input);
    await controller.book(request, "group", "entry", input);
    await controller.unlink(request, "group", "entry", command);
    expect(finance.overview).toHaveBeenCalledWith("jwt-owner", "group");
    expect(finance.enable).toHaveBeenCalledWith("jwt-owner", "group", enable);
    expect(finance.preview).toHaveBeenCalledWith(
      "jwt-owner",
      "group",
      "entry",
      input,
    );
    expect(finance.book).toHaveBeenCalledWith(
      "jwt-owner",
      "group",
      "entry",
      input,
    );
    expect(finance.unlink).toHaveBeenCalledWith(
      "jwt-owner",
      "group",
      "entry",
      command,
    );
  });
  it("passes both accepted halves and their preview fingerprint to the combined command", async () => {
    const service = mocks("preview", "save");
    const controller = new SharedEntryFinanceController(
      service as unknown as SharedEntryFinanceService,
    );
    const input: SaveSharedEntryFinanceDto = {
      ...command,
      previewFingerprint: "b".repeat(64),
      entry: {
        ...command,
        type: "EXPENSE",
        title: "Dinner",
        amount: "300",
        currencyCode: "PLN",
        date: "2026-01-01",
        splitMode: "EQUAL",
        shares: [],
        contributions: [],
      },
      finance: { ...command, categoryId: "category" },
    };
    expect(await controller.preview(request, "group", input)).toEqual({
      id: "result",
    });
    expect(await controller.save(request, "group", input)).toEqual({
      id: "result",
    });
    expect(service.preview).toHaveBeenCalledWith("jwt-owner", "group", input);
    expect(service.save).toHaveBeenCalledWith("jwt-owner", "group", input);
  });
  it("uses the authenticated owner for the cross-group review summary", async () => {
    const summary = jest.fn().mockResolvedValue({ pendingCount: 2 });
    const controller = new SharedReviewController({
      summary,
    } as unknown as SharedReviewService);
    expect(await controller.summary(request)).toEqual({ pendingCount: 2 });
    expect(summary).toHaveBeenCalledWith("jwt-owner");
  });
  it("keeps group-only files and entry files in their selected destination", async () => {
    const documents = mocks("list", "upload", "publish", "update");
    documents.list.mockResolvedValue({
      items: [{ id: "file" }],
      nextOffset: 100,
    });
    const controller = new SharedDocumentsController(
      documents as unknown as SharedDocumentsService,
    );
    expect(await controller.list(request, "group", { offset: 100 })).toEqual({
      items: [{ id: "file" }],
      nextOffset: 100,
    });
    expect(await controller.groupList(request, "group")).toEqual([
      { id: "file" },
    ]);
    expect(await controller.entryList(request, "group", "entry")).toEqual([
      { id: "file" },
    ]);
    expect(documents.list.mock.calls).toEqual([
      ["jwt-owner", "group", 100],
      ["jwt-owner", "group", 0, undefined, true],
      ["jwt-owner", "group", 0, "entry"],
    ]);
    const publish = {
      operationId: "publish",
      sourceAttachmentId: "private-file",
      includeOriginal: false,
    };
    const update = {
      expectedRevision: 3,
      filename: "receipt.png",
      documentKind: "receipt" as const,
      entryId: "entry",
    };
    await controller.publish(request, "group", publish);
    await controller.update(request, "group", "file", update);
    expect(documents.publish).toHaveBeenCalledWith(
      "jwt-owner",
      "group",
      publish,
    );
    expect(documents.update).toHaveBeenCalledWith(
      "jwt-owner",
      "group",
      "file",
      update,
    );
  });
  it.each([true, false])(
    "passes an uploaded scan pair without manufacturing a missing original: %s",
    async (hasFiles) => {
      const documents = mocks("upload");
      const controller = new SharedDocumentsController(
        documents as unknown as SharedDocumentsService,
      );
      const file = {
        originalname: "scan.png",
        buffer: Buffer.from("scan"),
        size: 4,
      } as Express.Multer.File;
      const original = {
        originalname: "photo.png",
        buffer: Buffer.from("original"),
        size: 8,
      } as Express.Multer.File;
      const parts = hasFiles ? { file: [file], original: [original] } : {};
      const dto = { operationId: "upload", documentKind: "receipt" as const };
      await controller.uploadGroup(request, "group", dto, parts);
      await controller.uploadEntry(request, "group", "entry", dto, parts);
      expect(documents.upload.mock.calls).toEqual([
        [
          "jwt-owner",
          "group",
          undefined,
          dto,
          hasFiles ? file : undefined,
          hasFiles ? original : undefined,
        ],
        [
          "jwt-owner",
          "group",
          "entry",
          dto,
          hasFiles ? file : undefined,
          hasFiles ? original : undefined,
        ],
      ]);
    },
  );
});
