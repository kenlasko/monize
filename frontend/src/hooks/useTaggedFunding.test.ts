import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@/test/render";
import { useTaggedFunding } from "./useTaggedFunding";
import type { TransferScope } from "@/lib/transfer-scope";

const basisState = vi.hoisted(() => ({
  basis: undefined as "cash" | "accrual" | undefined,
}));
vi.mock("@/components/reports/ReportingBasis", () => ({
  useReportingBasis: () => basisState.basis,
}));
const mockGetIncomeVsExpenses = vi.fn();
vi.mock("@/lib/built-in-reports", () => ({
  builtInReportsApi: {
    getIncomeVsExpenses: (...args: unknown[]) =>
      mockGetIncomeVsExpenses(...args),
  },
}));
vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const base = {
  tagKey: "scope",
  tagValue: "household",
  startDate: "2026-08-01",
  endDate: "2026-08-31",
  accountIds: [] as string[],
  transferScope: { pending: false } as TransferScope,
};
const totals = {
  income: 3279,
  expenses: 8486,
  net: 0,
  knownIncome: 3279,
  knownExpenses: 8486,
  knownNet: 0,
};

describe("useTaggedFunding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    basisState.basis = undefined;
  });

  it("makes no request while disabled", async () => {
    const { result } = renderHook(() =>
      useTaggedFunding({ ...base, enabled: false }),
    );
    await act(async () => {});
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(result.current.status).toBe("off");
    expect(result.current.window).toBeNull();
  });

  it("asks for month buckets by the key, with the account scope when there is one", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
      tagKey: "scope",
      buckets: [
        {
          value: "household",
          isUntagged: false,
          data: [],
          totals,
          taggedInflows: 4516,
          taggedOutflows: 0,
          missingCurrencies: [],
          excludedCount: 0,
        },
      ],
    });
    const { result } = renderHook(() =>
      useTaggedFunding({ ...base, enabled: true, accountIds: ["a1"] }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      bucket: "month",
      tagKey: "scope",
      accountIds: ["a1"],
    });
    expect(result.current.window?.taggedInflows).toBe(4516);
    expect(result.current.window?.knownIncome).toBe(3279);
  });

  it('bounds "All Accounts" by the offered accounts, not by accountIds (spec 10.8.1)', async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
      tagKey: "scope",
      buckets: [],
    });
    const { result } = renderHook(() =>
      useTaggedFunding({
        ...base,
        enabled: true,
        transferScope: { pending: false, accountIds: ["a1", "a2"] },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockGetIncomeVsExpenses).toHaveBeenCalledWith({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      bucket: "month",
      tagKey: "scope",
      transferScopeAccountIds: ["a1", "a2"],
    });
  });

  it("lets a selection carry the boundary and sends no transferScopeAccountIds", async () => {
    mockGetIncomeVsExpenses.mockResolvedValue({
      data: [],
      totals,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
      tagKey: "scope",
      buckets: [],
    });
    const { result } = renderHook(() =>
      useTaggedFunding({
        ...base,
        enabled: true,
        accountIds: ["a1"],
        transferScope: { pending: false, accountIds: ["a1", "a2"] },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockGetIncomeVsExpenses.mock.calls[0][0]).not.toHaveProperty(
      "transferScopeAccountIds",
    );
    expect(mockGetIncomeVsExpenses.mock.calls[0][0].accountIds).toEqual(["a1"]);
  });

  it("makes no request and reads as loading while the boundary is pending", async () => {
    const { result } = renderHook(() =>
      useTaggedFunding({
        ...base,
        enabled: true,
        transferScope: { pending: true },
      }),
    );
    await act(async () => {});
    expect(mockGetIncomeVsExpenses).not.toHaveBeenCalled();
    expect(result.current.status).toBe("loading");
    expect(result.current.window).toBeNull();
  });

  it("reports a failed request as an error, not as missing data", async () => {
    mockGetIncomeVsExpenses.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() =>
      useTaggedFunding({ ...base, enabled: true }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.window).toBeNull();
  });
});

describe("useTaggedFunding reporting basis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    basisState.basis = "cash";
  });

  it("sends the view basis and masks an earlier funding answer while it changes", async () => {
    const response = {
      data: [],
      totals,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
      tagKey: "scope",
      buckets: [],
    };
    mockGetIncomeVsExpenses.mockResolvedValueOnce(response);
    let finishAccrual!: (value: unknown) => void;
    mockGetIncomeVsExpenses.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAccrual = resolve;
        }),
    );
    const { result, rerender } = renderHook(() =>
      useTaggedFunding({ ...base, enabled: true }),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith(
      expect.objectContaining({ basis: "cash" }),
    );

    basisState.basis = "accrual";
    rerender();
    expect(result.current.status).toBe("loading");
    expect(result.current.window).toBeNull();
    expect(result.current.response).toBeNull();
    await waitFor(() =>
      expect(mockGetIncomeVsExpenses).toHaveBeenLastCalledWith(
        expect.objectContaining({ basis: "accrual" }),
      ),
    );
    await act(async () => {
      finishAccrual(response);
    });
    expect(result.current.status).toBe("ready");
  });
});
