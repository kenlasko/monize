import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
import { AccrualForm } from "./AccrualForm";
import { AccrualDialog } from "./AccrualDialog";
import { accrualsApi, type AccrualPreview } from "@/lib/accruals";
import { transactionsApi } from "@/lib/transactions";

vi.mock("@/lib/accruals", () => ({
  accrualsApi: {
    preview: vi.fn(),
    save: vi.fn(),
    detail: vi.fn(),
    remove: vi.fn(),
    sourceSchedules: vi.fn(),
  },
}));
vi.mock("@/lib/transactions", () => ({
  transactionsApi: { getById: vi.fn() },
}));
const source = {
  transactionId: "source",
  splitId: null,
  amount: "-1200.0001",
  paymentDate: "2026-06-15",
  currencyCode: "USD",
  currencyDecimals: 2,
};
const dates = [
  "2026-06-30",
  "2026-07-31",
  "2026-08-31",
  "2026-09-30",
  "2026-10-31",
  "2026-11-30",
  "2026-12-31",
  "2027-01-31",
  "2027-02-28",
  "2027-03-31",
  "2027-04-30",
  "2027-05-31",
];
const plan = {
  startMonth: "2026-06",
  monthCount: 12,
  amount: "-1200.0001",
  allocations: dates.map((recognitionDate, periodIndex) => ({
    periodIndex,
    recognitionDate,
    amount: periodIndex === 11 ? "-100.0001" : "-100.0000",
  })),
};

const preview: AccrualPreview = {
  source,
  family: "expense",
  plan,
  before: null,
  expectedScheduleId: null,
  expectedRevision: null,
  fingerprint: "preview-token",
  timingBalances: [
    { asOf: "2026-06-15", amount: "1200.0001" },
    ...dates.map((asOf, index) => ({
      asOf,
      amount: [
        "1100.0001",
        "1000.0001",
        "900.0001",
        "800.0001",
        "700.0001",
        "600.0001",
        "500.0001",
        "400.0001",
        "300.0001",
        "200.0001",
        "100.0001",
        "0.0000",
      ][index],
    })),
  ],
};
const schedule = {
  id: "schedule",
  sourceSplitId: null,
  preset: "NTM" as const,
  startMonth: "2026-06",
  monthCount: 12,
  revision: 4,
  family: "expense" as const,
};
const props = () => ({
  transactionId: "source",
  paymentMonth: "2026-06",
  component: {
    id: null,
    label: "Whole transaction",
    family: "expense" as const,
  },
  onSaved: vi.fn(),
  onBusyChange: vi.fn(),
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accrualsApi.preview).mockResolvedValue(preview);
  vi.mocked(accrualsApi.save).mockResolvedValue();
});
describe("Accrual dialog financial review", () => {
  it("requires a server preview and commits exactly the reviewed request and expectation tokens", async () => {
    const p = props();
    render(<AccrualForm {...p} />);
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    expect(accrualsApi.preview).toHaveBeenCalledWith({
      sourceTransactionId: "source",
      sourceSplitId: null,
      preset: "NTM",
      family: "expense",
    });
    expect(screen.getAllByText(/100\.0001/).length).toBeGreaterThan(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(accrualsApi.save).toHaveBeenCalledWith(
      {
        sourceTransactionId: "source",
        sourceSplitId: null,
        preset: "NTM",
        family: "expense",
      },
      preview,
    );
    expect(p.onSaved).toHaveBeenCalledOnce();
  });
  it("shows income recognition and the unearned-revenue preview from the server", async () => {
    const incomePreview: AccrualPreview = {
      ...preview,
      family: "income",
      source: { ...source, amount: "1200.0001" },
      plan: {
        ...plan,
        amount: "1200.0001",
        allocations: plan.allocations.map((row) => ({
          ...row,
          amount: row.amount.slice(1),
        })),
      },
    };
    vi.mocked(accrualsApi.preview).mockResolvedValue(incomePreview);
    render(
      <AccrualForm
        {...props()}
        component={{ id: null, label: "Whole transaction", family: "income" }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    expect(accrualsApi.preview).toHaveBeenCalledWith(
      expect.objectContaining({ family: "income" }),
    );
    expect(screen.getByText("Unearned revenue (net)")).toBeInTheDocument();
    expect(
      screen.queryByText("Prepaid expenses (net)"),
    ).not.toBeInTheDocument();
  });

  it("invalidates the reviewed preview when the allocation period changes and bounds custom input", async () => {
    render(<AccrualForm {...props()} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    fireEvent.change(screen.getByLabelText("Allocation period"), {
      target: { value: "CUSTOM" },
    });
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Start month"), {
      target: { value: "" },
    });
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Start month"), {
      target: { value: "2026-02" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    expect(accrualsApi.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        preset: "CUSTOM",
        startMonth: "2026-02",
        monthCount: 12,
      }),
    );
  });
  it("requires a fresh preview after a stale-save conflict and does not retry the write automatically", async () => {
    vi.mocked(accrualsApi.save).mockRejectedValue(
      new AxiosError("changed", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 409,
      } as never),
    );
    const onStale = vi.fn();
    render(<AccrualForm {...props()} onStale={onStale} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Review a fresh preview",
    );
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(accrualsApi.save).toHaveBeenCalledOnce();
    expect(onStale).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    expect(accrualsApi.preview).toHaveBeenCalledTimes(2);
  });
  it("shows the saved allocations before removing with the separately reviewed revision and fingerprint", async () => {
    const detail = { source, schedule, plan, fingerprint: "removal-token" };
    vi.mocked(accrualsApi.detail).mockResolvedValue(detail);
    vi.mocked(accrualsApi.remove).mockResolvedValue();
    await act(async () => {
      render(<AccrualForm {...props()} schedule={schedule} />);
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove accrual" }));
    expect(accrualsApi.remove).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Remove all allocation periods/),
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove accrual" }));
    });
    expect(accrualsApi.remove).toHaveBeenCalledWith(detail);
  });
  it("discards a late preview after switching source components", async () => {
    let resolve!: (value: AccrualPreview) => void;
    vi.mocked(accrualsApi.preview).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const p = props();
    const view = render(<AccrualForm key="first" {...p} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    });
    view.rerender(
      <AccrualForm
        key="second"
        {...p}
        component={{ id: "second", label: "Second", family: "income" }}
      />,
    );
    await act(async () => {
      resolve(preview);
    });
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(screen.queryAllByText(/100\.0001/)).toHaveLength(0);
  });
  it("shows a failed source lookup as a retryable error, not an empty split list", async () => {
    vi.mocked(transactionsApi.getById).mockRejectedValue(
      new Error("Source unavailable"),
    );
    vi.mocked(accrualsApi.sourceSchedules).mockResolvedValue([]);
    await act(async () => {
      render(
        <AccrualDialog
          transactionId="source"
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Source unavailable"),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.queryByText("No eligible category split"),
    ).not.toBeInTheDocument();
  });
});

it("embeds the schedule and allocation preview without submitting its parent transaction", async () => {
  const submit = vi.fn((event) => event.preventDefault());
  render(
    <form onSubmit={submit}>
      <input aria-label="Unsaved description" defaultValue="Keep this edit" />
      <AccrualForm {...props()} embedded />
    </form>,
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Preview" })),
  );
  expect(screen.getAllByText(/100\.0001/).length).toBeGreaterThan(0);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Save" })),
  );
  expect(submit).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Unsaved description")).toHaveValue(
    "Keep this edit",
  );
});
