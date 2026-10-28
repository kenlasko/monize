import { act, renderHook, render, screen } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { accrualsApi } from "@/lib/accruals";
import { useAccrualEditorDraft } from "./AccrualEditorTab";
import { AccrualPlanTable } from "./AccrualPreviewTable";
vi.mock("@/lib/accruals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/accruals")>()),
  accrualsApi: {
    sourceSchedules: vi.fn(),
    editorPreview: vi.fn(),
    editorSave: vi.fn(),
  },
}));
const value = { fingerprint: "reviewed-token", previews: [] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accrualsApi.sourceSchedules).mockResolvedValue([
    {
      id: "schedule",
      sourceSplitId: null,
      preset: "NTM",
      startMonth: "2026-06",
      monthCount: 12,
      revision: 1,
      family: "expense",
    },
  ]);
  vi.mocked(accrualsApi.editorPreview).mockResolvedValue(value);
  vi.mocked(accrualsApi.editorSave).mockResolvedValue({});
});
it("retains settings and reviews the unsaved source patch before a single combined save", async () => {
  const { result } = await act(async () =>
    renderHook(() => useAccrualEditorDraft("source")),
  );
  expect(result.current.hasSchedules).toBe(true);
  act(() =>
    result.current.update([
      {
        sourceTransactionId: "source",
        preset: "CUSTOM",
        startMonth: "2026-10",
        monthCount: 6,
      },
    ]),
  );
  expect(result.current.changed).toBe(true);
  let saved: boolean | undefined;
  await act(async () => {
    saved = await result.current.save({
      amount: -2400,
      transactionDate: "2026-10-15",
    });
  });
  expect(saved).toBe(false);
  expect(accrualsApi.editorSave).not.toHaveBeenCalled();
  expect(accrualsApi.editorPreview).toHaveBeenLastCalledWith("source", {
    patch: { amount: -2400, transactionDate: "2026-10-15" },
    settings: [
      {
        sourceTransactionId: "source",
        preset: "CUSTOM",
        startMonth: "2026-10",
        monthCount: 6,
      },
    ],
  });
  await act(async () => {
    saved = await result.current.save({
      amount: -2400,
      transactionDate: "2026-10-15",
    });
  });
  expect(saved).toBe(true);
  expect(accrualsApi.editorSave).toHaveBeenCalledWith(
    "source",
    expect.objectContaining({
      fingerprint: "reviewed-token",
      patch: { amount: -2400, transactionDate: "2026-10-15" },
    }),
  );
});
it("discards a preview arriving after any draft change", async () => {
  const { result } = await act(async () =>
    renderHook(() => useAccrualEditorDraft("source")),
  );
  let resolve!: (response: typeof value) => void;
  vi.mocked(accrualsApi.editorPreview).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  let pending!: Promise<unknown>;
  act(() => {
    pending = result.current.preview({ amount: -2400 });
  });
  act(() => result.current.invalidate());
  await act(async () => {
    resolve(value);
    await pending;
  });
  expect(result.current.value).toBeNull();
});
it("marks only the explored recognition month, and removes that mark when omitted", () => {
  const plan = {
    startMonth: "2026-10",
    monthCount: 2,
    amount: "-400",
    allocations: [
      { periodIndex: 0, recognitionDate: "2026-10-31", amount: "-200" },
      { periodIndex: 1, recognitionDate: "2026-11-30", amount: "-200" },
    ],
  };
  const { rerender } = render(
    <AccrualPlanTable plan={plan} currency="USD" highlightDate="2026-11-30" />,
  );
  expect(screen.getByRole("row", { selected: true })).toHaveTextContent(
    "11/30/2026",
  );
  rerender(<AccrualPlanTable plan={plan} currency="USD" />);
  expect(screen.queryByRole("row", { selected: true })).not.toBeInTheDocument();
});
