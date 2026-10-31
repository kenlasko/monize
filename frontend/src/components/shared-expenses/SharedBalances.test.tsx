import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@/test/render";
import { SharedBalances } from "./SharedBalances";
import { sharedGroupFixture } from "./__fixtures__/shared-fixtures";
import { sharedExpensesApi } from "@/lib/shared-expenses";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { remind: vi.fn() },
}));
describe("SharedBalances", () => {
  beforeEach(() => vi.mocked(sharedExpensesApi.remind).mockReset());
  it("keeps suggestions as suggestions until the repayment editor is opened", () => {
    const onRepay = vi.fn();
    render(<SharedBalances group={sharedGroupFixture()} onRepay={onRepay} />);
    expect(onRepay).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Record Repayment" })[0],
    );
    expect(onRepay).toHaveBeenCalledWith({
      fromParticipantId: "anna",
      toParticipantId: "me",
      amount: "150.0000",
    });
  });
  it("withholds settlement actions while a rate is unresolved", () => {
    const group = sharedGroupFixture();
    render(
      <SharedBalances
        group={{
          ...group,
          balances: { ...group.balances, settlementReady: false },
        }}
        onRepay={vi.fn()}
      />,
    );
    expect(screen.getByText(/currency rate is missing/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record Repayment" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remind" }),
    ).not.toBeInTheDocument();
  });
  it.each([{ role: "VIEWER" as const }, { archivedAt: "2026-10-25" }])(
    "leaves archived and read-only groups readable",
    (patch) => {
      render(
        <SharedBalances group={sharedGroupFixture(patch)} onRepay={vi.fn()} />,
      );
      expect(screen.getByText(/Anna → Me/)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Record Repayment" }),
      ).not.toBeInTheDocument();
    },
  );
  it("previews reminder text, retains a failed command and sends it only on confirmation", async () => {
    vi.mocked(sharedExpensesApi.remind)
      .mockRejectedValueOnce(new Error("Try again later"))
      .mockResolvedValueOnce({} as never);
    render(<SharedBalances group={sharedGroupFixture()} onRepay={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remind" }));
    expect(sharedExpensesApi.remind).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Remind Anna" }),
    ).toHaveTextContent(/shared group has an update/i);
    fireEvent.click(screen.getByRole("button", { name: "Send Reminder" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Try again later",
    );
    const first = vi.mocked(sharedExpensesApi.remind).mock.calls[0];
    fireEvent.click(screen.getByRole("button", { name: "Send Reminder" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Reminder sent" }),
      ).toBeDisabled(),
    );
    expect(vi.mocked(sharedExpensesApi.remind).mock.calls[1]).toEqual(first);
  });
});
