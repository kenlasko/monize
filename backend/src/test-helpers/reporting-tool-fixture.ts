import { BuiltInReportsService } from "../built-in-reports/built-in-reports.service";
/** Real shared dispatch, mocked report producers. Financial math/default preference
 * behavior is covered by enforced database tests, independently of these fixtures. */
export function reportToolFixture(
  reports: Record<string, any>,
  netWorth: Record<string, any>,
) {
  const read = (BuiltInReportsService.prototype as any).readLlmReport;
  const fixture = {
    ...reports,
    netWorthService: netWorth,
    readLlmReport: (userId: string, input: unknown) =>
      read.call(fixture, userId, input),
  };
  return (
    userId: string,
    input: Parameters<BuiltInReportsService["getLlmReport"]>[1],
  ) =>
    BuiltInReportsService.prototype.getLlmReport.call(
      fixture as unknown as BuiltInReportsService,
      userId,
      input,
    );
}
