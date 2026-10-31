import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { SharedEntryDetail } from "./SharedEntryDetail";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { reverse: vi.fn() },
}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function Documents({
      onPendingChange,
    }: {
      onPendingChange: (pending: boolean) => void;
    }) {
      return (
        <button onClick={() => onPendingChange(true)}>
          Select an attachment
        </button>
      );
    },
}));

describe("Cancelling a shared entry", () => {
  beforeEach(() => vi.clearAllMocks());
  it("requires an explicit decision about pending files before cancelling the entry", async () => {
    const onClose = vi.fn();
    await act(async () =>
      render(
        <SharedEntryDetail
          entry={sharedEntryFixture()}
          group={sharedGroupFixture()}
          onClose={onClose}
          onEdit={vi.fn()}
          onRefund={vi.fn()}
          onChanged={vi.fn()}
        />,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Select an attachment" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel Entry" }));
    expect(
      screen.getByText(
        "Some selected files have not been uploaded. Stay here to upload them, or leave and discard the selection.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Reason for cancelling"),
    ).not.toBeInTheDocument();
    expect(sharedExpensesApi.reverse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(screen.getByLabelText("Reason for cancelling")).toBeInTheDocument();
    expect(
      screen.getByText(/Cancel an entry recorded by mistake/),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
