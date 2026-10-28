import { act, fireEvent, render, screen } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { accrualsApi } from "@/lib/accruals";
import { AccruedTransactionNotice } from "./AccruedTransactionNotice";

vi.mock("@/lib/accruals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accruals")>()),
  accrualsApi: { sources: vi.fn() },
}));
vi.mock("./AccrualDialog", () => ({
  AccrualDialog: ({
    transactionId,
    onClose,
    onSaved,
  }: {
    transactionId: string;
    onClose: () => void;
    onSaved: () => void;
  }) => (
    <div role="dialog" aria-label="Schedule">
      <span>{transactionId}</span>
      <button type="button" onClick={onClose}>
        Close schedule
      </button>
      <button type="button" onClick={onSaved}>
        Save schedule
      </button>
    </div>
  ),
}));
beforeEach(() => vi.clearAllMocks());
it("opens the original source schedule without submitting or replacing unsaved editor fields", async () => {
  vi.mocked(accrualsApi.sources).mockResolvedValue([
    { sourceTransactionId: "parent", scheduleCount: 2 },
  ]);
  const submit = vi.fn((event) => event.preventDefault());
  await act(async () =>
    render(
      <form onSubmit={submit}>
        <input aria-label="Description" defaultValue="Unsaved edit" />
        <AccruedTransactionNotice sourceId="parent" />
      </form>,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /Accrual/ }));
  expect(screen.getByRole("dialog")).toHaveTextContent("parent");
  fireEvent.click(screen.getByRole("button", { name: "Close schedule" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Description")).toHaveValue("Unsaved edit");
  expect(submit).not.toHaveBeenCalled();
});
it("refreshes schedule state and the host after saving, without submitting the transaction", async () => {
  vi.mocked(accrualsApi.sources)
    .mockResolvedValueOnce([
      { sourceTransactionId: "parent", scheduleCount: 1 },
    ])
    .mockResolvedValueOnce([]);
  const changed = vi.fn();
  await act(async () =>
    render(<AccruedTransactionNotice sourceId="parent" onChanged={changed} />),
  );
  fireEvent.click(screen.getByRole("button", { name: /Accrual/ }));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" })),
  );
  expect(changed).toHaveBeenCalledOnce();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Accrual/ })).toBeInTheDocument();
  expect(screen.queryByText("Accrued")).not.toBeInTheDocument();
});
it("distinguishes a failed schedule lookup from a transaction without accruals and allows retry", async () => {
  vi.mocked(accrualsApi.sources)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce([]);
  await act(async () => render(<AccruedTransactionNotice sourceId="parent" />));
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Accrual/ })).toBeInTheDocument();
  expect(screen.queryByText("Accrued")).not.toBeInTheDocument();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retry" })),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
