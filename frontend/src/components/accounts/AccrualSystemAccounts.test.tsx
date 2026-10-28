import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { AccrualSystemAccounts } from "./AccrualSystemAccounts";
import { accrualsApi, type AccrualSystemMovements } from "@/lib/accruals";
import { useAuthStore } from "@/store/authStore";
vi.mock("@/lib/accruals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accruals")>()),
  accrualsApi: { systemBalances: vi.fn(), systemMovements: vi.fn() },
}));
vi.mock("@/hooks/useFinancialToday", () => ({
  useFinancialToday: () => "2026-06-30",
}));
const movements: AccrualSystemMovements = {
  readOnly: true,
  basis: "accrual",
  account: { id: "system-id", family: "expense", currencyCode: "USD" },
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  opening: "0.0000",
  closing: "1100.0001",
  count: 1,
  rows: [
    {
      date: "2026-06-15",
      kind: "payment",
      amount: "1200.0001",
      sourceTransactionId: "source-id",
      sourceSplitId: null,
      scheduleId: "schedule-id",
      accountId: "cash-id",
      cashDate: "2026-06-15",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accrualsApi.systemBalances).mockReset();
  vi.mocked(accrualsApi.systemMovements).mockReset();
  useAuthStore.setState({ actingAsUserId: null });
  vi.mocked(accrualsApi.systemBalances).mockResolvedValue({
    basis: "accrual",
    asOf: "2026-06-30",
    accounts: [
      {
        id: "system-id",
        family: "expense",
        currencyCode: "USD",
        date: "2026-06-30",
        balance: "1100.0001",
      },
    ],
  });
  vi.mocked(accrualsApi.systemMovements).mockResolvedValue(movements);
});
it("shows read-only native-currency balances and original-payment backlinks", async () => {
  await act(async () => {
    render(<AccrualSystemAccounts />);
  });
  expect(screen.getByText("USD")).toBeInTheDocument();
  expect(accrualsApi.systemBalances).toHaveBeenCalledWith("2026-06-30");
  expect(accrualsApi.systemMovements).toHaveBeenCalledWith(
    "system-id",
    "2026-06-01",
    "2026-06-30",
  );
  expect(screen.getByRole("link", { name: "Payment date" })).toHaveAttribute(
    "href",
    "/transactions?basis=cash&accountId=cash-id&startDate=2026-06-15&endDate=2026-06-15&accountStatus=all&highlightTransactionId=source-id",
  );
  expect(
    screen.queryByRole("button", { name: /edit|delete|reconcile/i }),
  ).not.toBeInTheDocument();
});
it("refuses delegated access without fetching any balances", async () => {
  useAuthStore.setState({ actingAsUserId: "owner-id" });
  render(<AccrualSystemAccounts />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(accrualsApi.systemBalances).not.toHaveBeenCalled();
});
it("shows a retryable failure rather than zero or an empty list", async () => {
  vi.mocked(accrualsApi.systemBalances).mockRejectedValueOnce(
    new Error("offline"),
  );
  await act(async () => {
    render(<AccrualSystemAccounts />);
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  expect(accrualsApi.systemBalances).toHaveBeenCalledTimes(2);
  await screen.findByText("USD");
});
it("discards an old as-of response after a date change", async () => {
  let old!: (
    value: Awaited<ReturnType<typeof accrualsApi.systemBalances>>,
  ) => void;
  vi.mocked(accrualsApi.systemBalances)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockResolvedValueOnce({
      basis: "accrual",
      asOf: "2026-07-31",
      accounts: [],
    });
  render(<AccrualSystemAccounts />);
  await waitFor(() =>
    expect(accrualsApi.systemBalances).toHaveBeenCalledTimes(1),
  );
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Balance as of"), {
      target: { value: "07/31/2026" },
    });
    fireEvent.blur(screen.getByLabelText("Balance as of"));
  });
  await screen.findByText(/No accrual accounts yet/);
  await act(async () =>
    old({
      basis: "accrual",
      asOf: "2026-06-30",
      accounts: [
        {
          id: "late",
          family: "expense",
          currencyCode: "EUR",
          date: "2026-06-30",
          balance: "100",
        },
      ],
    }),
  );
  expect(screen.queryByText("EUR")).not.toBeInTheDocument();
});

it("embeds balances and movement details without a separate page heading or backlink", async () => {
  await act(async () => {
    render(<AccrualSystemAccounts embedded />);
  });
  expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "Payment date" }),
  ).toBeInTheDocument();
});
