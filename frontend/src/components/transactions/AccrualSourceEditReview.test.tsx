import { act, fireEvent, render, renderHook, screen } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { accrualsApi, type AccrualSourceImpact } from "@/lib/accruals";
import {
  AccrualSourceEditReview,
  useAccrualSourceEditReview,
} from "./AccrualSourceEditReview";
vi.mock("@/lib/accruals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accruals")>()),
  accrualsApi: { sourcePreview: vi.fn() },
}));
const plan = {
  startMonth: "2026-10",
  monthCount: 1,
  amount: "-1200.0001",
  allocations: [
    { periodIndex: 0, recognitionDate: "2026-10-31", amount: "-1200.0001" },
  ],
};
const preview: AccrualSourceImpact = {
  fingerprint: "reviewed",
  impacts: [
    {
      scheduleId: "schedule",
      sourceSplitId: null,
      removed: false,
      before: plan,
      after: { ...plan, amount: "-900.0001" },
      familyBefore: "expense",
      familyAfter: "income",
      currencyBefore: "USD",
      currencyAfter: "EUR",
      paymentDateBefore: "2026-10-05",
      paymentDateAfter: "2026-11-06",
      timingBalances: [
        { asOf: "2026-10-31", before: "0.0000", after: "900.0001" },
      ],
    },
  ],
};
beforeEach(() => vi.clearAllMocks());
it("shows before/after plans, currency and timing balances and allows cancellation", async () => {
  const onDecision = vi.fn();
  render(<AccrualSourceEditReview preview={preview} onDecision={onDecision} />);
  expect(screen.getByText("After edit")).toBeInTheDocument();
  expect(screen.getAllByText(/USD/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByText("Cancel"));
  expect(onDecision).toHaveBeenCalledWith(false);
});
it("shows removed periods explicitly", () => {
  render(
    <AccrualSourceEditReview
      preview={{
        ...preview,
        impacts: [{ ...preview.impacts[0], removed: true, after: null }],
      }}
      onDecision={vi.fn()}
    />,
  );
  expect(
    screen.getByText(
      "This edit removes this allocation schedule and all its periods.",
    ),
  ).toBeInTheDocument();
});
it("freezes the exact submitted patch and only returns it after explicit review", async () => {
  vi.mocked(accrualsApi.sourcePreview).mockResolvedValue(preview);
  const { result } = renderHook(() => useAccrualSourceEditReview("source"));
  const patch = { amount: -1200, tagIds: ["tag"] };
  let pending!: ReturnType<typeof result.current.review>;
  await act(async () => {
    pending = result.current.review(patch);
  });
  patch.amount = -9;
  patch.tagIds.push("later");
  const view = render(result.current.dialog!);
  await act(async () => {
    fireEvent.click(screen.getByText("Save reviewed changes"));
  });
  expect(await pending).toEqual({
    amount: -1200,
    tagIds: ["tag"],
    accrualImpactFingerprint: "reviewed",
  });
  view.unmount();
});
it("cancellation and unmount never return a writable patch", async () => {
  vi.mocked(accrualsApi.sourcePreview).mockResolvedValue(preview);
  const { result, unmount } = renderHook(() =>
    useAccrualSourceEditReview("source"),
  );
  let pending!: ReturnType<typeof result.current.review>;
  await act(async () => {
    pending = result.current.review({ amount: -5 });
  });
  unmount();
  expect(await pending).toBeNull();
});
it("discards an old source preview after switching transactions", async () => {
  let resolve!: (value: AccrualSourceImpact) => void;
  vi.mocked(accrualsApi.sourcePreview).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { result, rerender } = renderHook(
    ({ id }) => useAccrualSourceEditReview(id),
    { initialProps: { id: "old" } },
  );
  let pending!: ReturnType<typeof result.current.review>;
  await act(async () => {
    pending = result.current.review({ amount: -5 });
  });
  rerender({ id: "new" });
  await act(async () => resolve(preview));
  expect(await pending).toBeNull();
  expect(result.current.dialog).toBeNull();
});
it("an unscheduled source returns the detached patch without a confirmation", async () => {
  vi.mocked(accrualsApi.sourcePreview).mockResolvedValue({
    fingerprint: null,
    impacts: [],
  });
  const { result } = renderHook(() => useAccrualSourceEditReview("source"));
  let patch;
  await act(async () => {
    patch = await result.current.review({ amount: 0 });
  });
  expect(patch).toEqual({ amount: 0 });
  expect(result.current.dialog).toBeNull();
});
it("a preview failure is not treated as an unscheduled source", async () => {
  vi.mocked(accrualsApi.sourcePreview).mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useAccrualSourceEditReview("source"));
  await act(async () => {
    await expect(result.current.review({ amount: 0 })).rejects.toThrow(
      "offline",
    );
  });
  expect(result.current.dialog).toBeNull();
});

it("renders no review without an owned source", () => {
  const { result } = renderHook(() => useAccrualSourceEditReview(undefined));
  expect(result.current.dialog).toBeNull();
  expect(accrualsApi.sourcePreview).not.toHaveBeenCalled();
});
