import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { SharedDocumentCopy } from "./SharedDocumentCopy";
import { attachmentsApi } from "@/lib/attachments";
import { sharedDocumentsApi } from "@/lib/shared-documents";
vi.mock("@/lib/attachments", async (original) => ({
  ...(await original<typeof import("@/lib/attachments")>()),
  attachmentsApi: { list: vi.fn() },
}));
vi.mock("@/lib/shared-documents", async (original) => ({
  ...(await original<typeof import("@/lib/shared-documents")>()),
  sharedDocumentsApi: { publish: vi.fn() },
}));
vi.mock("./SharedTransactionPicker", () => ({
  SharedTransactionPicker: ({
    onChoose,
  }: {
    onChoose: (row: { id: string }) => void;
  }) => (
    <button onClick={() => onChoose({ id: "bank-row" })}>
      Select private bank row
    </button>
  ),
}));
vi.mock("./SharedWarrantyPicker", () => ({
  SharedWarrantyPicker: ({ onChoose }: { onChoose: (id: string) => void }) => (
    <button onClick={() => onChoose("warranty")}>
      Select private warranty
    </button>
  ),
}));
vi.mock("@/components/transactions/AttachmentPreviewDialog", () => ({
  AttachmentPreviewDialog: () => null,
}));
describe("Explicit publication of a private document", () => {
  beforeEach(() => {
    vi.mocked(attachmentsApi.list)
      .mockReset()
      .mockResolvedValue([
        {
          id: "converted",
          filename: "receipt.pdf",
          originalAttachmentId: "original",
        },
        { id: "another", filename: "other.pdf" },
      ] as never);
    vi.mocked(sharedDocumentsApi.publish)
      .mockReset()
      .mockResolvedValue({ id: "published" } as never);
  });
  async function choose(onSaved = vi.fn()) {
    await act(async () => {
      render(
        <SharedDocumentCopy
          groupId="group"
          entryId="entry"
          onClose={vi.fn()}
          onSaved={onSaved}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Select private bank row" }),
      );
    });
    fireEvent.change(await screen.findByLabelText("Document to copy"), {
      target: { value: "converted" },
    });
    return onSaved;
  }
  it("publishes a separate converted copy without the original unless explicitly chosen", async () => {
    const onSaved = await choose();
    expect(screen.getByRole("switch")).not.toBeChecked();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create Shared Copy" }),
      );
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(sharedDocumentsApi.publish).toHaveBeenCalledWith(
      "group",
      expect.objectContaining({
        sourceAttachmentId: "converted",
        entryId: "entry",
        includeOriginal: false,
      }),
    );
  });
  it("resets original consent when the document changes and reuses the operation on a network retry", async () => {
    const onSaved = await choose();
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Document to copy"), {
      target: { value: "another" },
    });
    fireEvent.change(screen.getByLabelText("Document to copy"), {
      target: { value: "converted" },
    });
    expect(screen.getByRole("switch")).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch"));
    vi.mocked(sharedDocumentsApi.publish).mockRejectedValueOnce(
      new Error("Network failed"),
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create Shared Copy" }),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network failed",
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Create Shared Copy" }),
      );
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(vi.mocked(sharedDocumentsApi.publish).mock.calls[0]).toEqual(
      vi.mocked(sharedDocumentsApi.publish).mock.calls[1],
    );
    expect(
      vi.mocked(sharedDocumentsApi.publish).mock.calls[1][1].includeOriginal,
    ).toBe(true);
  });
  it("clears a bank selection before exposing files from a warranty", async () => {
    await choose();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Warranty documents" }),
      );
    });
    expect(
      screen.getByRole("button", { name: "Create Shared Copy" }),
    ).toBeDisabled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Select private warranty" }),
      );
    });
    await waitFor(() =>
      expect(attachmentsApi.list).toHaveBeenLastCalledWith({
        warrantyId: "warranty",
      }),
    );
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(sharedDocumentsApi.publish).not.toHaveBeenCalled();
  });
});
