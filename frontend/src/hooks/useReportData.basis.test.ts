import { act, renderHook } from "@/test/render";
import { expect, it, vi } from "vitest";
import { useReportData } from "./useReportData";
it("masks prior data immediately on basis change and discards a late old response", async () => {
  let old!: (value: string) => void;
  let next!: (value: string) => void;
  const fetcher = vi
    .fn()
    .mockReturnValueOnce(
      new Promise((resolve) => {
        old = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        next = resolve;
      }),
    );
  const { result, rerender } = await act(async () =>
    renderHook(
      ({ basis }) =>
        useReportData(fetcher, [basis, "2026-01"], {
          requestKey: JSON.stringify([basis, "2026-01"]),
          maskStaleData: true,
        }),
      {
        initialProps: { basis: "cash" },
      },
    ),
  );
  await act(async () => rerender({ basis: "accrual" }));
  await act(async () => next("recognized"));
  expect(result.current.data).toBe("recognized");
  await act(async () => old("cash source"));
  expect(result.current.data).toBe("recognized");
});
it("keeps a failure distinct from empty data and permits a retry", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error("missing rate"))
    .mockResolvedValue([]);
  const { result } = await act(async () =>
    renderHook(() =>
      useReportData(fetcher, ["accrual"], {
        requestKey: "accrual",
        maskStaleData: true,
      }),
    ),
  );
  expect(result.current.error?.message).toBe("missing rate");
  expect(result.current.isLoading).toBe(false);
  await act(async () => result.current.reload());
  expect(result.current.error).toBeNull();
  expect(result.current.data).toEqual([]);
});
it("masks a successful previous period before the new period answers", async () => {
  let resolve!: (value: number) => void;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(0)
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
  const { result, rerender } = await act(async () =>
    renderHook(
      ({ month }) =>
        useReportData(fetcher, ["cash", month], {
          requestKey: JSON.stringify(["cash", month]),
          maskStaleData: true,
        }),
      {
        initialProps: { month: "2026-01" },
      },
    ),
  );
  expect(result.current.data).toBe(0);
  await act(async () => rerender({ month: "2026-02" }));
  expect(result.current.data).toBeNull();
  expect(result.current.isLoading).toBe(true);
  await act(async () => resolve(7));
  expect(result.current.data).toBe(7);
});
