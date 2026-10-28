import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import { RecognitionDetailsDialog } from "./RecognitionDetailsDialog";
import {
  reportingDetailsApi,
  type ReportingDetails,
} from "@/lib/reporting-details";
vi.mock("@/lib/reporting-details", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/reporting-details")>()),
  reportingDetailsApi: { get: vi.fn() },
}));
const input = {
  basis: "accrual" as const,
  startDate: "2026-01-01",
  endDate: "2026-01-31",
  categoryIds: ["11111111-1111-4111-8111-111111111111"],
};
const result: ReportingDetails = {
  basis: "accrual",
  currency: "USD",
  readOnly: true,
  fxComplete: false,
  total: null,
  knownSubtotal: 0,
  missingRatePairs: [],
  rows: [
    {
      sourceTransactionId: "source-id",
      sourceSplitId: "split-id",
      scheduleId: "schedule-id",
      cashDate: "2026-06-15",
      effectiveDate: "2026-01-01",
      nativeAmount: "-100",
      sourceAmount: "-1200",
      currencyCode: "EUR",
      convertedAmount: null,
      accountId: "account-id",
      kind: "ordinary",
      readOnly: true,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reportingDetailsApi.get).mockReset();
});
it("shows incomplete conversion without inventing zero and links to the original payment date", async () => {
  vi.mocked(reportingDetailsApi.get).mockResolvedValue(result);
  render(<RecognitionDetailsDialog input={input} onClose={vi.fn()} />);
  const link = await screen.findByRole("link");
  expect(link).toHaveAttribute(
    "href",
    "/transactions?basis=cash&accountId=account-id&startDate=2026-06-15&endDate=2026-06-15&accountStatus=all&highlightTransactionId=source-id",
  );
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /edit/i }),
  ).not.toBeInTheDocument();
  expect(reportingDetailsApi.get).toHaveBeenCalledWith(input);
});
it("refuses unsupported filters without requesting a wider set of facts", async () => {
  render(<RecognitionDetailsDialog input={null} onClose={vi.fn()} />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  await act(async () => {});
  expect(reportingDetailsApi.get).not.toHaveBeenCalled();
});
it("retains dimensions on a date change and ignores the late previous response", async () => {
  let resolveOld!: (value: ReportingDetails) => void;
  vi.mocked(reportingDetailsApi.get)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce({ ...result, rows: [], fxComplete: true, total: 0 });
  render(<RecognitionDetailsDialog input={input} onClose={vi.fn()} />);
  await waitFor(() => expect(reportingDetailsApi.get).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("Start Date"), {
    target: { value: "02/01/2026" },
  });
  fireEvent.blur(screen.getByLabelText("Start Date"));
  await waitFor(() =>
    expect(reportingDetailsApi.get).toHaveBeenCalledWith({
      ...input,
      startDate: "2026-02-01",
    }),
  );
  await act(async () => resolveOld(result));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("shows request failures and retries instead of displaying an empty result", async () => {
  vi.mocked(reportingDetailsApi.get)
    .mockRejectedValueOnce(new Error("REPORTING_ROW_LIMIT"))
    .mockResolvedValueOnce({ ...result, rows: [], fxComplete: true, total: 0 });
  render(<RecognitionDetailsDialog input={input} onClose={vi.fn()} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  await waitFor(() => expect(reportingDetailsApi.get).toHaveBeenCalledTimes(2));
});
