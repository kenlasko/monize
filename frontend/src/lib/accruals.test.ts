import { beforeEach, describe, expect, it, vi } from "vitest";
import apiClient from "./api";
import {
  accrualsApi,
  type AccrualPreview,
  type AccrualDetail,
} from "./accruals";
import { clearAllCache, getCached, setCache } from "./apiCache";
vi.mock("./api", () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
beforeEach(() => {
  vi.clearAllMocks();
  clearAllCache();
});
describe("Accrual API expectations and cache boundaries", () => {
  it("sends the reviewed source expectation on save and invalidates derived reports only on success", async () => {
    setCache("budgets:summary", { spent: 0 });
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error("conflict"));
    const input = { sourceTransactionId: "source", preset: "NTM" as const };
    // Only the commit expectation fields are read by this adapter.
    const preview = {
      fingerprint: "reviewed",
      expectedScheduleId: "schedule",
      expectedRevision: 7,
    } as AccrualPreview;
    await expect(accrualsApi.save(input, preview)).rejects.toThrow("conflict");
    expect(getCached("budgets:summary")).toEqual({ spent: 0 });
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: {} });
    await accrualsApi.save(input, preview);
    expect(apiClient.post).toHaveBeenLastCalledWith("/accruals", {
      ...input,
      fingerprint: "reviewed",
      expectedScheduleId: "schedule",
      expectedRevision: 7,
    });
    expect(getCached("budgets:summary")).toBeUndefined();
  });
  it("uses the removal fingerprint and revision rather than the save preview token", async () => {
    vi.mocked(apiClient.delete).mockResolvedValue({ data: {} });
    const detail = {
      schedule: { id: "schedule", revision: 8 },
      fingerprint: "removal-review",
    } as AccrualDetail;
    await accrualsApi.remove(detail);
    expect(apiClient.delete).toHaveBeenCalledWith("/accruals/schedule", {
      data: { fingerprint: "removal-review", expectedRevision: 8 },
    });
  });
});

it("sends only selected source IDs and the exact source-edit patch", async () => {
  vi.mocked(apiClient.post).mockResolvedValue({ data: [] });
  await accrualsApi.sources(["first", "second"]);
  expect(apiClient.post).toHaveBeenLastCalledWith("/accruals/sources", {
    sourceTransactionIds: ["first", "second"],
  });
  const patch = { amount: -5, splits: [{ id: "retained", amount: -5 }] };
  await accrualsApi.sourcePreview("source", patch);
  expect(apiClient.post).toHaveBeenLastCalledWith("/accruals/source-preview", {
    sourceTransactionId: "source",
    patch,
  });
});

it("requests uncached native-currency system balances and bounded read-only movements", async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ data: { accounts: [] } });
  await accrualsApi.systemBalances("2026-06-30");
  expect(apiClient.get).toHaveBeenCalledWith("/accruals/system-balances", {
    params: { asOf: "2026-06-30" },
  });
  await accrualsApi.systemMovements("system-id", "2026-06-01", "2026-06-30");
  expect(apiClient.get).toHaveBeenLastCalledWith(
    "/accruals/system-accounts/system-id/movements",
    { params: { startDate: "2026-06-01", endDate: "2026-06-30", limit: 2000 } },
  );
  expect(apiClient.post).not.toHaveBeenCalled();
  expect(apiClient.delete).not.toHaveBeenCalled();
});


it('retires prior-state derived caches only after a successful editor preview', async () => {
  const input = { patch: { amount: -1200 }, settings: [] };
  setCache('budgets:editor-preview', { spent: 50 });
  vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('stale source'));
  await expect(accrualsApi.editorPreview('source', input)).rejects.toThrow('stale source');
  expect(getCached('budgets:editor-preview')).toEqual({ spent: 50 });
  vi.mocked(apiClient.post).mockResolvedValueOnce({ data: { fingerprint: 'reviewed' } });
  await accrualsApi.editorPreview('source', input);
  expect(apiClient.post).toHaveBeenLastCalledWith('/transactions/source/accrual-editor/preview', input);
  expect(getCached('budgets:editor-preview')).toBeUndefined();
});
