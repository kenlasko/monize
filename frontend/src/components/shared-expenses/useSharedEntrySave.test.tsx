import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test/render";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import {
  sharedDocumentsApi,
  type SharedDocument,
} from "@/lib/shared-documents";
import { initialSharedEntry } from "@/lib/shared-split-draft";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";
import { useSharedEntrySave } from "./useSharedEntrySave";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { saveEntry: vi.fn() },
}));
vi.mock("@/lib/shared-documents", async (original) => ({
  ...(await original<typeof import("@/lib/shared-documents")>()),
  sharedDocumentsApi: { list: vi.fn(), upload: vi.fn(), update: vi.fn() },
}));

const draft = initialSharedEntry(sharedGroupFixture(), "2026-10-28");
describe("Shared entry save and document recovery", () => {
  beforeEach(() => {
    vi.mocked(sharedExpensesApi.saveEntry).mockReset();
    vi.mocked(sharedDocumentsApi.list).mockReset();
    vi.mocked(sharedDocumentsApi.upload).mockReset();
    vi.mocked(sharedDocumentsApi.update).mockReset();
    vi.mocked(sharedExpensesApi.saveEntry).mockResolvedValue(
      sharedEntryFixture(),
    );
    vi.mocked(sharedDocumentsApi.list).mockResolvedValue({
      items: [],
      nextOffset: null,
    });
    vi.mocked(sharedDocumentsApi.upload).mockResolvedValue({
      id: "document",
    } as SharedDocument);
  });
  function setup(sourceDocument?: SharedDocument) {
    const onSaved = vi.fn(),
      onClose = vi.fn();
    const hook = renderHook(() =>
      useSharedEntrySave({
        groupId: "group",
        onSaved,
        onClose,
        sourceDocument,
      }),
    );
    return { ...hook, onSaved, onClose };
  }
  it("closes a successful save without opening an attachments step", async () => {
    const { result, onSaved, onClose } = setup();
    await act(async () => result.current.save(draft, sharedEntryFixture()));
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(sharedDocumentsApi.upload).not.toHaveBeenCalled();
  });
  it("retries only failed uploads on the same entry with the same operation ID", async () => {
    const { result, onSaved, onClose } = setup();
    const first = {
      file: new File(["a"], "fuel.pdf", { type: "application/pdf" }),
    };
    const original = new File(["photo"], "coffee.jpg", { type: "image/jpeg" });
    const second = {
      file: new File(["b"], "coffee.png", { type: "image/png" }),
      original,
    };
    await act(async () => result.current.queue([first, second]));
    vi.mocked(sharedDocumentsApi.upload)
      .mockResolvedValueOnce({ id: "fuel" } as SharedDocument)
      .mockRejectedValueOnce(new Error("Upload interrupted"));
    await act(async () => result.current.save(draft, sharedEntryFixture()));
    expect(result.current.saved?.id).toBe("entry");
    expect(result.current.files.map((file) => file.file.name)).toEqual([
      "coffee.png",
    ]);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => result.current.save(draft));
    expect(sharedExpensesApi.saveEntry).toHaveBeenCalledOnce();
    const calls = vi.mocked(sharedDocumentsApi.upload).mock.calls;
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[2][2].original).toBe(original);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("retains the expense command after a lost response and uploads nothing before confirmation", async () => {
    const { result, onClose } = setup();
    vi.mocked(sharedExpensesApi.saveEntry).mockRejectedValueOnce(
      new Error("Lost response"),
    );
    await act(async () => result.current.save(draft, sharedEntryFixture()));
    expect(sharedDocumentsApi.upload).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => result.current.save(draft, sharedEntryFixture()));
    const calls = vi.mocked(sharedExpensesApi.saveEntry).mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("accepts a recovered source link without repeating its stale PATCH", async () => {
    const source = {
      id: "receipt",
      documentRevision: 1,
      filename: "receipt.pdf",
      documentKind: "receipt",
    } as SharedDocument;
    const { result, onClose } = setup(source);
    vi.mocked(sharedDocumentsApi.update).mockRejectedValueOnce(
      new Error("Lost PATCH response"),
    );
    await act(async () => result.current.save(draft, sharedEntryFixture()));
    expect(onClose).not.toHaveBeenCalled();
    vi.mocked(sharedDocumentsApi.list).mockResolvedValue({
      items: [{ ...source, sharedEntryId: "entry" }],
      nextOffset: null,
    });
    await act(async () => result.current.save(draft));
    expect(sharedExpensesApi.saveEntry).toHaveBeenCalledOnce();
    expect(sharedDocumentsApi.update).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("ignores another submit while the first expense request is unresolved", async () => {
    const { result, onClose } = setup();
    let complete!: (entry: ReturnType<typeof sharedEntryFixture>) => void;
    vi.mocked(sharedExpensesApi.saveEntry).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.save(draft, sharedEntryFixture());
      await result.current.save(draft, sharedEntryFixture());
    });
    expect(sharedExpensesApi.saveEntry).toHaveBeenCalledOnce();
    await act(async () => {
      complete(sharedEntryFixture());
      await pending;
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
