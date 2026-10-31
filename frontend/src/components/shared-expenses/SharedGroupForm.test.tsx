import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { setAuthenticatedState } from "@/test/mocks/stores";
import { SharedGroupForm } from "./SharedGroupForm";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { exchangeRatesApi } from "@/lib/exchange-rates";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { createGroup: vi.fn(), people: vi.fn() },
}));
vi.mock("@/lib/exchange-rates", async (original) => ({
  ...(await original<typeof import("@/lib/exchange-rates")>()),
  exchangeRatesApi: { getCurrencies: vi.fn() },
}));
describe("SharedGroupForm", () => {
  beforeEach(() => {
    setAuthenticatedState();
    vi.mocked(sharedExpensesApi.createGroup).mockReset();
    vi.mocked(sharedExpensesApi.people).mockResolvedValue([]);
    vi.mocked(exchangeRatesApi.getCurrencies).mockResolvedValue([
      { code: "CAD", name: "Canadian dollar", decimalPlaces: 2, symbol: "$" },
    ] as never);
  });
  it("prefills the profile first name without treating an untouched form as dirty", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(<SharedGroupForm onClose={onClose} onCreated={vi.fn()} />);
    });
    expect(screen.getByLabelText("Your Name")).toHaveValue("Test");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Discard these changes?"),
    ).not.toBeInTheDocument();
  });
  it("guards currency-only edits before closing the group form", async () => {
    vi.mocked(exchangeRatesApi.getCurrencies).mockResolvedValue([
      { code: "CAD", name: "Canadian dollar", decimalPlaces: 2, symbol: "$" },
      { code: "USD", name: "US dollar", decimalPlaces: 2, symbol: "$" },
    ] as never);
    const onClose = vi.fn();
    await act(async () =>
      render(<SharedGroupForm onClose={onClose} onCreated={vi.fn()} />),
    );
    const currency = screen.getByLabelText(
      "Settlement Currency",
    ) as HTMLSelectElement;
    fireEvent.change(currency, {
      target: { value: currency.value === "CAD" ? "USD" : "CAD" },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Discard these changes?")).toBeInTheDocument();
  });
  it("creates a group with named people without requiring invitations or accounts", async () => {
    vi.mocked(sharedExpensesApi.createGroup).mockResolvedValue({
      id: "new-group",
    });
    const onCreated = vi.fn();
    render(<SharedGroupForm onClose={vi.fn()} onCreated={onCreated} />);
    await screen.findByRole("option", { name: /Canadian dollar/ });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Group Name"), {
      target: { value: " Weekend " },
    });
    fireEvent.change(screen.getByLabelText("Your Name"), {
      target: { value: " Me " },
    });
    fireEvent.change(screen.getByLabelText("Person’s name"), {
      target: { value: " Anna " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("new-group"));
    expect(sharedExpensesApi.createGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Weekend",
        myName: "Me",
        participants: [{ name: "Anna" }],
      }),
    );
  });
  it("keeps an unsuccessful create available for retry with its operation ID", async () => {
    vi.mocked(sharedExpensesApi.createGroup)
      .mockRejectedValueOnce(new Error("Network failed"))
      .mockResolvedValueOnce({ id: "new-group" });
    const onCreated = vi.fn();
    render(<SharedGroupForm onClose={vi.fn()} onCreated={onCreated} />);
    await screen.findByRole("option", { name: /Canadian dollar/ });
    fireEvent.change(screen.getByLabelText("Group Name"), {
      target: { value: "Weekend" },
    });
    fireEvent.change(screen.getByLabelText("Your Name"), {
      target: { value: "Me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(vi.mocked(sharedExpensesApi.createGroup).mock.calls[0]).toEqual(
      vi.mocked(sharedExpensesApi.createGroup).mock.calls[1],
    );
  });
  it("reuses a saved private person without inviting or exposing their payee", async () => {
    vi.mocked(sharedExpensesApi.people).mockResolvedValue([
      { id: "contact", name: "Anna", payeeId: "private-payee", groups: [] },
    ]);
    vi.mocked(sharedExpensesApi.createGroup).mockResolvedValue({
      id: "new-group",
    });
    render(<SharedGroupForm onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(
      await screen.findByLabelText("Add someone from your people"),
      { target: { value: "contact" } },
    );
    fireEvent.change(screen.getByLabelText("Group Name"), {
      target: { value: "Weekend" },
    });
    fireEvent.change(screen.getByLabelText("Your Name"), {
      target: { value: "Me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sharedExpensesApi.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          participants: [{ name: "Anna", personId: "contact" }],
        }),
      ),
    );
  });
});
