'use client';

import { useReportAccountScope, type ReportAccountScope } from '@/hooks/useReportAccountScope';
import { useTaggedFundsFilter, type TaggedFundsFilter } from '@/hooks/useTaggedFundsFilter';
import { useTaggedFunding, type TaggedFunding } from '@/hooks/useTaggedFunding';

export interface FundingReportControls {
  scope: ReportAccountScope;
  filter: TaggedFundsFilter;
  funding: TaggedFunding;
}

/**
 * The account filter, the tag controls and the funding fetch of a report that
 * takes the funding view (`docs/specs/report-tag-key-breakdown.md` section 11.2)
 * as one unit: the report passes its window, reads `scope.selectedAccountIds`
 * into its own request, and hands the whole object to the two components that
 * draw it. The persisted choices are keyed `monize-reports-<reportKey>-accounts`
 * and `monize-reports-<reportKey>-include-transfers`.
 */
export function useFundingReportControls(params: {
  reportKey: string;
  startDate: string | undefined;
  endDate: string;
  /** False while the report's own window is not a valid request. */
  enabled: boolean;
  /** The funding answer's period width; the report's own columns'. Defaults to month. */
  bucket?: 'month' | 'year';
}): FundingReportControls {
  const scope = useReportAccountScope(`monize-reports-${params.reportKey}-accounts`);
  // The value here only picks whose transfers the funding view shows.
  const filter = useTaggedFundsFilter(
    `monize-reports-${params.reportKey}-include-transfers`,
    { valueRequired: true },
  );
  const funding = useTaggedFunding({
    enabled: params.enabled && filter.include,
    tagKey: filter.tagKey,
    tagValue: filter.tagValue,
    startDate: params.startDate,
    endDate: params.endDate,
    bucket: params.bucket,
    accountIds: scope.selectedAccountIds,
    transferScope: scope.transferScope,
  });
  return { scope, filter, funding };
}
