import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import type { SharedEntry } from "@/types/shared-expense";
import { initialSharedEntry } from "@/lib/shared-split-draft";
import { SharedSplitEditor } from "./SharedSplitEditor";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";
vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { preview: vi.fn() },
}));

describe("Server allocation in the unified split", () => {
  it("waits for an automatic amount before editing, then keeps a cleared focused field editable while previewing", async () => {
    const user = userEvent.setup();
    const group = sharedGroupFixture();
    const input = { ...initialSharedEntry(group, "2026-10-25"), amount: "100" };
    const requests: ((entry: SharedEntry) => void)[] = [];
    vi.mocked(sharedExpensesApi.preview).mockImplementation(
      () => new Promise((resolve) => requests.push(resolve)),
    );
    const onApply = vi.fn();
    await act(async () =>
      render(
        <SharedSplitEditor
          groupId={group.id}
          input={input}
          participants={group.participants}
          places={2}
          onApply={onApply}
          onClose={vi.fn()}
        />,
      ),
    );
    const amount = () => screen.getByLabelText("Share for Me");
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(amount()).toBeDisabled();
    const allocation = (mine: string, theirs: string) =>
      sharedEntryFixture({
        allocations: [
          {
            participantId: "me",
            kind: "SHARE",
            entryId: "entry",
            instructionValue: null,
            originalAmount: mine,
            groupAmount: mine,
          },
          {
            participantId: "anna",
            kind: "SHARE",
            entryId: "entry",
            instructionValue: null,
            originalAmount: theirs,
            groupAmount: theirs,
          },
        ],
      });
    await act(async () => requests[0](allocation("50", "50")));
    expect(amount()).toHaveValue("50.00");
    await user.click(amount());
    const focusedField = amount();
    await user.clear(amount());
    expect(amount()).toBe(focusedField);
    expect(amount()).toBeEnabled();
    await user.type(amount(), "20");
    await user.tab();
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () => requests[1](allocation("20", "80")));
    expect(amount()).toHaveValue("20.00");
    expect(screen.getByLabelText("Share for Anna")).toHaveValue("80.00");
    await user.click(screen.getByRole("button", { name: "Apply Split" }));
    expect(onApply).toHaveBeenCalledWith({
      splitMode: "EXACT",
      shares: [
        { participantId: "me", value: "20" },
        { participantId: "anna", value: "80.00" },
      ],
    });
  });

  it("preserves edit identity, displays the server's cent and rejects a late response", async () => {
    const group = sharedGroupFixture();
    const input = {
      ...initialSharedEntry(group, "2026-10-25"),
      amount: "100.01",
    };
    const requests: ((entry: SharedEntry) => void)[] = [];
    vi.mocked(sharedExpensesApi.preview).mockImplementation(
      () => new Promise((resolve) => requests.push(resolve)),
    );
    const onApply = vi.fn();
    await act(async () =>
      render(
        <SharedSplitEditor
          groupId={group.id}
          entryId="saved-entry"
          input={input}
          participants={group.participants}
          places={2}
          onApply={onApply}
          onClose={vi.fn()}
        />,
      ),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    const call = vi.mocked(sharedExpensesApi.preview).mock.calls[0];
    expect(call[1]).toMatchObject({
      operationId: input.operationId,
      splitMode: "EQUAL",
      shares: input.shares,
    });
    expect(call[2]).toBe("saved-entry");
    await act(async () =>
      requests[0](
        sharedEntryFixture({
          allocations: [
            {
              participantId: "me",
              kind: "SHARE",
              entryId: "entry",
              instructionValue: null,
              originalAmount: "50.00",
              groupAmount: "50.00",
            },
            {
              participantId: "anna",
              kind: "SHARE",
              entryId: "entry",
              instructionValue: null,
              originalAmount: "50.01",
              groupAmount: "50.01",
            },
          ],
        }),
      ),
    );
    expect(screen.getByLabelText("Share for Me")).toHaveValue("50.00");
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Shares for Me"), {
        target: { value: "2" },
      }),
    );
    expect(screen.getByLabelText("Share for Anna")).toHaveValue("");
    await waitFor(() => expect(requests).toHaveLength(2));
    await act(async () =>
      fireEvent.change(screen.getByLabelText("Shares for Me"), {
        target: { value: "3" },
      }),
    );
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () =>
      requests[1](
        sharedEntryFixture({
          allocations: [
            {
              participantId: "anna",
              kind: "SHARE",
              entryId: "entry",
              instructionValue: null,
              originalAmount: "33.34",
              groupAmount: "33.34",
            },
          ],
        }),
      ),
    );
    expect(screen.getByLabelText("Share for Anna")).toHaveValue("");
    await act(async () =>
      requests[2](
        sharedEntryFixture({
          allocations: [
            {
              participantId: "anna",
              kind: "SHARE",
              entryId: "entry",
              instructionValue: null,
              originalAmount: "25",
              groupAmount: "25",
            },
          ],
        }),
      ),
    );
    expect(screen.getByLabelText("Share for Anna")).toHaveValue("25.00");
    expect(onApply).not.toHaveBeenCalled();
  });
});
