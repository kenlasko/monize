import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@/test/render";
import { usePortfolioPeriodResult } from "./usePortfolioPeriodResult";
import { netWorthApi } from "@/lib/net-worth";
import type {
  PortfolioPeriodResult,
  PortfolioPeriodResults,
} from "@/types/net-worth";

vi.mock("@/lib/net-worth", () => ({
  netWorthApi: { getInvestmentsPeriodResult: vi.fn() },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function result(
  overrides: Partial<PortfolioPeriodResult> = {},
): PortfolioPeriodResult {
  return {
    currency: "CAD",
    startDate: "2026-01-02",
    startPriceDate: "2026-01-02",
    endDate: "2026-06-30",
    startValue: 10000,
    endValue: 20000,
    valueChange: 10000,
    netExternalFlows: 10000,
    knownFlowSubtotal: 10000,
    investmentResult: 0,
    returnPercent: 0,
    returnMethod: "simple",
    complete: true,
    reasons: [],
    missingRatePairs: [],
    unpricedSecurityIds: [],
    unknownCashAccountIds: [],
    ...overrides,
  };
}

const base = {
  startDate: "2026-01-02",
  periodStartDate: "2026-01-02",
  endDate: "2026-06-30",
  hasSeries: true,
};

describe("usePortfolioPeriodResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockResolvedValue(
      result(),
    );
  });

  it("asks nothing while skipped, and asks once it is not", async () => {
    const { result: hook, rerender } = renderHook(
      ({ skip }) => usePortfolioPeriodResult({ ...base, range: "1y", skip }),
      { initialProps: { skip: true } },
    );
    expect(hook.current.periodResult).toBeNull();
    expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled();

    rerender({ skip: false });
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
    expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledTimes(1);
  });

  it("names the window rather than dating it, so the drawn window cannot widen it", async () => {
    // The chart DRAWS 1Y from a day before the anniversary so the first
    // plotted close precedes the year. Measuring over that window reports a
    // day the range does not name, and disagrees with the performance card
    // beside it, which resolves 1Y from the server's own preset.
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: "1y",
        accountIds: "a1,a2",
        displayCurrency: "USD",
      }),
    );
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
    expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
      period: "1y",
      accountIds: "a1,a2",
      displayCurrency: "USD",
    });
    expect(hook.current.periodResult?.investmentResult).toBe(0);
  });

  it("measures 1D over a day, whatever window the chart drew for it", async () => {
    // `resolveRangePreset` widens 1D to a week so a daily fallback has more
    // than one point to plot. Sending that window measured a week's move under
    // a "1D" caption and dated it seven days back.
    renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        startDate: "2026-06-22",
        periodStartDate: "2026-06-23",
        range: "1d",
      }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
        period: "1d",
        accountIds: undefined,
        displayCurrency: undefined,
      }),
    );
  });

  it("asks for the all-time window, which has no start date to send", async () => {
    // `resolveRangePreset('all')` resolves to an empty start, so a dated
    // request was never made at all and both figures read n/a for every
    // account. The server opens the window on the scope's own history.
    renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        startDate: "",
        periodStartDate: "",
        range: "all",
      }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: "all" }),
      ),
    );
  });

  it("dates a range with no preset from the window it draws, the day before the period as its baseline", async () => {
    // MTD draws its series from the last day of the previous month, the close
    // the month is measured from and the point the chart opens on; the period
    // itself opens on the 1st. The baseline is that day, never the day before
    // the first point on screen: the first point on screen IS the baseline's
    // close, and a day before it measured from the wrong session.
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: "mtd",
        startDate: "2026-06-30",
        periodStartDate: "2026-07-01",
        endDate: "2026-07-15",
      }),
    );
    // Waited on the ANSWER, not on the call: the payload is adopted in the
    // request's own `.then`, so a wait that stops at the call asserts against
    // state the callback has not written yet and fails under load.
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
    expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
      startDate: "2026-07-01",
      endDate: "2026-07-15",
      baselineDate: "2026-06-30",
      accountIds: undefined,
      displayCurrency: undefined,
    });
  });

  it("sends no baseline for a dated window measured from its own first day", async () => {
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: "custom",
        startDate: "2026-03-04",
        periodStartDate: "2026-03-04",
        endDate: "2026-05-06",
      }),
    );
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
    expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith({
      startDate: "2026-03-04",
      endDate: "2026-05-06",
      baselineDate: undefined,
      accountIds: undefined,
      displayCurrency: undefined,
    });
  });

  it("asks nothing for a dated window while the series is empty", async () => {
    renderHook(() =>
      usePortfolioPeriodResult({ ...base, range: "mtd", hasSeries: false }),
    );
    await waitFor(() =>
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled(),
    );
  });

  it("leaves the figures unknown when the request fails", async () => {
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockRejectedValue(
      new Error("period unavailable"),
    );
    const { result: hook } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        range: "1y",
      }),
    );
    expect(hook.current.failed).toBe(false);
    await waitFor(() => expect(hook.current.failed).toBe(true));
    expect(hook.current.periodResult).toBeNull();
  });

  it("does not show one window's answer under another window's key", async () => {
    let range = "1y";
    const { result: hook, rerender } = renderHook(() =>
      usePortfolioPeriodResult({
        ...base,
        hasSeries: true,
        range,
      }),
    );
    await waitFor(() => expect(hook.current.periodResult).not.toBeNull());

    // The next window's request hangs: the previous answer belongs to the
    // previous window and must not stand in for it.
    vi.mocked(netWorthApi.getInvestmentsPeriodResult).mockImplementation(
      () => new Promise(() => {}),
    );
    range = "3m";
    rerender();
    expect(hook.current.periodResult).toBeNull();
  });

  /**
   * The Investments page asks for the "Portfolio performance" batch once and
   * hands it to the chart: a named window the batch reports is the figure this
   * route would return, and asking again valued the same history twice at the
   * same moment (#1888).
   */
  describe("with the page's batch", () => {
    const batch = (
      periods: PortfolioPeriodResults["periods"],
      currency = "CAD",
    ) => ({
      results: { currency, asOf: "2026-06-30", periods },
      status: "ready" as const,
    });

    it("reads a named window from the batch without asking the server", () => {
      const fromBatch = result({ investmentResult: 42 });
      const { result: hook } = renderHook(() =>
        usePortfolioPeriodResult({
          ...base,
          range: "all",
          shared: batch({ all: fromBatch }),
        }),
      );
      expect(hook.current.periodResult).toBe(fromBatch);
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled();
    });

    it("waits for the batch rather than asking beside it", () => {
      const { result: hook } = renderHook(() =>
        usePortfolioPeriodResult({
          ...base,
          range: "1y",
          shared: { results: null, status: "loading" },
        }),
      );
      expect(hook.current.periodResult).toBeNull();
      expect(netWorthApi.getInvestmentsPeriodResult).not.toHaveBeenCalled();
    });

    it("asks for itself when the batch failed", async () => {
      const { result: hook } = renderHook(() =>
        usePortfolioPeriodResult({
          ...base,
          range: "1y",
          shared: { results: null, status: "error" },
        }),
      );
      await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: "1y" }),
      );
    });

    it("asks for itself when the batch does not report the window", async () => {
      const { result: hook } = renderHook(() =>
        usePortfolioPeriodResult({
          ...base,
          range: "5y",
          shared: batch({ "1y": result() }),
        }),
      );
      await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: "5y" }),
      );
    });

    it("asks for itself over a dated window the batch has no preset for", async () => {
      renderHook(() =>
        usePortfolioPeriodResult({
          ...base,
          range: "mtd",
          shared: batch({ "1m": result() }),
        }),
      );
      await waitFor(() =>
        expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
          expect.objectContaining({ startDate: base.periodStartDate }),
        ),
      );
    });

    it("never reads a batch reported in another currency", async () => {
      const { result: hook } = renderHook(() =>
        usePortfolioPeriodResult({
          ...base,
          range: "1y",
          displayCurrency: "USD",
          shared: batch({ "1y": result({ investmentResult: 7 }) }, "CAD"),
        }),
      );
      await waitFor(() => expect(hook.current.periodResult).not.toBeNull());
      expect(netWorthApi.getInvestmentsPeriodResult).toHaveBeenCalledWith(
        expect.objectContaining({ period: "1y", displayCurrency: "USD" }),
      );
    });
  });
});
