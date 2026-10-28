import { act, renderHook } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { accrualsApi } from "@/lib/accruals";
import { useAccrualBadges } from "./useAccrualBadges";
vi.mock("@/lib/accruals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accruals")>()),
  accrualsApi: { sources: vi.fn() },
}));
beforeEach(() => vi.clearAllMocks());
it("batches visible sources at the server ceiling and retains split schedule counts", async () => {
  vi.mocked(accrualsApi.sources).mockResolvedValue([
    { sourceTransactionId: "source", scheduleCount: 2 },
  ]);
  let result!: ReturnType<
    typeof renderHook<ReturnType<typeof useAccrualBadges>, unknown>
  >["result"];
  await act(async () => {
    ({ result } = renderHook(() =>
      useAccrualBadges(
        Array.from({ length: 201 }, (_, i) => `s${i}`),
        0,
      ),
    ));
  });
  expect(
    vi.mocked(accrualsApi.sources).mock.calls.map((call) => call[0].length),
  ).toEqual([100, 100, 1]);
  expect(result.current.counts?.get("source")).toBe(2);
});
it("distinguishes failure from an empty answer and retries explicitly", async () => {
  vi.mocked(accrualsApi.sources)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue([]);
  const { result } = await act(async () =>
    renderHook(() => useAccrualBadges(["source"], 0)),
  );
  expect(result.current.failed).toBe(true);
  expect(result.current.counts).toBeUndefined();
  await act(async () => result.current.retry());
  expect(result.current.failed).toBe(false);
  expect(result.current.counts?.size).toBe(0);
});
it("does not fetch for ineligible/delegate/demo rows", async () => {
  await act(async () => {
    renderHook(() => useAccrualBadges([], 0));
  });
  expect(accrualsApi.sources).not.toHaveBeenCalled();
});
it("discards a response belonging to old visible rows", async () => {
  let resolve!: (
    value: { sourceTransactionId: string; scheduleCount: number }[],
  ) => void;
  vi.mocked(accrualsApi.sources)
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValue([]);
  const { result, rerender } = await act(async () =>
    renderHook(({ ids }) => useAccrualBadges(ids, 0), {
      initialProps: { ids: ["old"] },
    }),
  );
  await act(async () => rerender({ ids: ["new"] }));
  await act(async () =>
    resolve([{ sourceTransactionId: "old", scheduleCount: 1 }]),
  );
  expect(result.current.counts?.has("old")).toBe(false);
});

it("refreshes unchanged source IDs when the page is fetched again", async () => {
  vi.mocked(accrualsApi.sources)
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ sourceTransactionId: "same", scheduleCount: 1 }]);
  const { result, rerender } = await act(async () =>
    renderHook(({ refresh }) => useAccrualBadges(["same"], refresh), {
      initialProps: { refresh: {} },
    }),
  );
  expect(result.current.counts?.size).toBe(0);
  await act(async () => rerender({ refresh: {} }));
  expect(accrualsApi.sources).toHaveBeenCalledTimes(2);
  expect(result.current.counts?.get("same")).toBe(1);
});
