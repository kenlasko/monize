"use client";

import { useReportingBasis, useReportingRouter } from "./ReportingBasis";
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useLayoutEffect,
} from "react";

import toast from "react-hot-toast";
import { ReportChart } from "./ReportChart";
import { ReportDetailHeader } from "@/components/reports/ReportDetailHeader";
import { Button } from "@/components/ui/Button";
import { DateInput } from "@/components/ui/DateInput";
import { Select } from "@/components/ui/Select";
import { customReportsApi } from "@/lib/custom-reports";
import { CHART_COLOURS } from "@/lib/chart-colours";
import {
  CustomReport,
  ReportResult,
  ReportViewType,
  TimeframeType,
  GroupByType,
  TIMEFRAME_LABELS,
} from "@/types/custom-report";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { createLogger } from "@/lib/logger";
import { getErrorMessage } from "@/lib/errors";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/ui/EmptyState";
import { PartialTotal } from "@/components/ui/PartialTotal";
import { PartialDataNotice } from "@/components/reports/PartialDataNotice";
import { reportTotal } from "@/lib/currency-total";

const logger = createLogger("CustomReportViewer");

interface CustomReportViewerProps {
  reportId: string;
}

export function CustomReportViewer({ reportId }: CustomReportViewerProps) {
  const basis = useReportingBasis();
  const t = useTranslations("reports");
  const tc = useTranslations("common");
  const router = useReportingRouter();
  const { formatCurrency, defaultCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [report, setReport] = useState<CustomReport | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [overrideTimeframe, setOverrideTimeframe] = useState<
    TimeframeType | ""
  >("");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const executionKey = JSON.stringify([
    reportId,
    basis,
    overrideTimeframe,
    customStartDate,
    customEndDate,
  ]);
  const currentKey = useRef(executionKey);
  const alive = useRef(true);
  useLayoutEffect(() => {
    currentKey.current = executionKey;
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadReport = useCallback(async () => {
    try {
      const reportData = await customReportsApi.getById(reportId);
      setReport(reportData);
    } catch (error) {
      toast.error(
        getErrorMessage(error, t("customReportViewer.toasts.loadFailed")),
      );
      logger.error(error);
    }
  }, [reportId, t]);

  // Whether the auto-execute effect below will run the report for the current
  // inputs: never before the report has loaded, nor for a custom range whose
  // dates are incomplete.
  const willExecute =
    !!report &&
    !(
      overrideTimeframe === TimeframeType.CUSTOM &&
      (!customStartDate || !customEndDate)
    );

  // The inputs the report last ran for. When they change, the "becomes
  // executing" transition happens here, during render, rather than from inside
  // the effect that sends the request.
  const [executeInputs, setExecuteInputs] = useState({
    basis,
    reportId,
    report,
    overrideTimeframe,
    customStartDate,
    customEndDate,
  });
  if (
    executeInputs.basis !== basis ||
    executeInputs.reportId !== reportId ||
    executeInputs.report !== report ||
    executeInputs.overrideTimeframe !== overrideTimeframe ||
    executeInputs.customStartDate !== customStartDate ||
    executeInputs.customEndDate !== customEndDate
  ) {
    setExecuteInputs({
      basis,
      reportId,
      report,
      overrideTimeframe,
      customStartDate,
      customEndDate,
    });
    setResult(null);
    if (willExecute) setIsExecuting(true);
  }

  const executeReport = useCallback(() => {
    if (!report) return Promise.resolve();

    // The state writes live in this inner function so they run once the
    // request settles, never synchronously inside the effect that calls this.
    const run = async () => {
      const origin = executionKey;
      const stale = () => !alive.current || currentKey.current !== origin;
      try {
        let params: {
          timeframeType?: TimeframeType;
          startDate?: string;
          endDate?: string;
        } = {};

        // Use override timeframe if selected
        if (overrideTimeframe) {
          params.timeframeType = overrideTimeframe;

          // Include custom dates if custom timeframe is selected
          if (
            overrideTimeframe === TimeframeType.CUSTOM &&
            customStartDate &&
            customEndDate
          ) {
            params.startDate = customStartDate;
            params.endDate = customEndDate;
          }
        }

        const resultData = await customReportsApi.execute(reportId, {
          ...params,
          ...(basis ? { basis } : {}),
        });
        if (stale()) return;
        setResult(resultData);
      } catch (error) {
        if (stale()) return;
        setResult(null);
        toast.error(
          getErrorMessage(error, t("customReportViewer.toasts.executeFailed")),
        );
        logger.error(error);
      } finally {
        if (!stale()) setIsExecuting(false);
      }
    };
    return run();
  }, [
    reportId,
    report,
    overrideTimeframe,
    customStartDate,
    customEndDate,
    t,
    basis,
    executionKey,
  ]);

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await loadReport();
      setIsLoading(false);
    };
    init();
  }, [loadReport]);

  useEffect(() => {
    if (!report) return;

    // Don't auto-execute if custom range is selected but dates are incomplete
    if (
      overrideTimeframe === TimeframeType.CUSTOM &&
      (!customStartDate || !customEndDate)
    ) {
      return;
    }

    executeReport();
  }, [
    report,
    executeReport,
    overrideTimeframe,
    customStartDate,
    customEndDate,
  ]);

  const handleDataPointClick = (id: string) => {
    if (!result) return;

    // Navigate to transactions filtered by the clicked item
    const params = new URLSearchParams();
    for (const key of [
      "accountIds",
      "categoryIds",
      "payeeIds",
      "tagIds",
    ] as const) {
      const ids = report?.filters[key];
      if (ids?.length) params.set(key, ids.join(","));
    }
    if (
      basis &&
      (report?.filters.searchText ||
        report?.filters.filterGroups?.length ||
        report?.config.includeTransfers ||
        (report?.config.direction && report.config.direction !== "BOTH"))
    )
      params.set("unsupported", "true");

    if (result.timeframe.startDate) {
      params.set("startDate", result.timeframe.startDate);
    }
    if (result.timeframe.endDate) {
      params.set("endDate", result.timeframe.endDate);
    }

    if (result.groupBy === GroupByType.CATEGORY) {
      if (report?.filters.categoryIds?.length)
        params.set("unsupported", "true");
      params.set("categoryId", id);
    } else if (result.groupBy === GroupByType.PAYEE) {
      if (report?.filters.payeeIds?.length) params.set("unsupported", "true");
      params.set("payeeId", id);
    }

    router.push(`/transactions?${params.toString()}`);
  };

  const timeframeOptions = [
    { value: "", label: t("customReportViewer.useSavedTimeframe") },
    ...Object.keys(TIMEFRAME_LABELS).map((value) => ({
      value,
      label: t(`customReportLabels.timeframe.${value}`),
    })),
  ];

  // Mirror ReportChart's colour assignment so legend swatches match chart slices/bars.
  const legendData = useMemo(() => {
    if (!result) return [];
    let colourIndex = 0;
    return result.data.map((item) => ({
      ...item,
      color: item.color || CHART_COLOURS[colourIndex++ % CHART_COLOURS.length],
    }));
  }, [result]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!report) {
    return (
      <EmptyState
        title={t("customReportViewer.notFound")}
        action={
          <Button variant="outline" onClick={() => router.push("/reports")}>
            {t("detailHeader.backToReports")}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <ReportDetailHeader
        reportId={`custom/${reportId}`}
        title={report.name}
        subtitle={report.description ?? undefined}
        actions={
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => router.push(`/reports/custom/${reportId}/edit`)}
          >
            {tc("edit")}
          </Button>
        }
      />

      {/* Timeframe Override */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="w-64">
            <Select
              label={t("customReportViewer.labelTimeframe")}
              options={timeframeOptions}
              value={overrideTimeframe}
              onChange={(e) =>
                setOverrideTimeframe(e.target.value as TimeframeType | "")
              }
            />
          </div>
          {overrideTimeframe === TimeframeType.CUSTOM && (
            <>
              <DateInput
                label={t("customReportViewer.labelStartDate")}
                value={customStartDate}
                onDateChange={(date) => setCustomStartDate(date)}
                onChange={(e) => setCustomStartDate(e.target.value)}
              />
              <DateInput
                label={t("customReportViewer.labelEndDate")}
                value={customEndDate}
                onDateChange={(date) => setCustomEndDate(date)}
                onChange={(e) => setCustomEndDate(e.target.value)}
              />
            </>
          )}
          {isExecuting && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              <span>{t("customReportViewer.updating")}</span>
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      {isExecuting ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-12">
          <div className="flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">
              {t("customReportViewer.generating")}
            </p>
          </div>
        </div>
      ) : result ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          {/* Summary */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {result.timeframe.label}
                {result.timeframe.startDate && result.timeframe.endDate && (
                  <span className="ml-1">
                    ({formatDate(result.timeframe.startDate)} –{" "}
                    {formatDate(result.timeframe.endDate)})
                  </span>
                )}
              </span>
              <span className="mx-2 text-gray-300 dark:text-gray-600">|</span>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t(`customReportLabels.viewType.${result.viewType}`)}
              </span>
            </div>
            <div className="text-right">
              <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {/* A null total is withheld, not zero: show the part that converted
                    and mark it. The count metric's total is never null. */}
                <PartialTotal
                  total={reportTotal(
                    result.summary.total ?? result.summary.knownTotal ?? 0,
                    result.summary.total === null ? result : null,
                  )}
                  displayCurrency={result.currency ?? defaultCurrency}
                >
                  {formatCurrency(
                    result.summary.total ?? result.summary.knownTotal ?? 0,
                  )}
                </PartialTotal>
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {t("customReportViewer.transactionCount", {
                  count: result.summary.count,
                })}
              </div>
            </div>
          </div>
          <div className="mb-4">
            <PartialDataNotice
              missingCurrencies={result.missingCurrencies ?? []}
              excludedCount={result.excludedCount ?? 0}
              displayCurrency={result.currency ?? defaultCurrency}
            />
          </div>

          {/* Chart */}
          {result.data.length > 0 ? (
            <ReportChart
              viewType={result.viewType as ReportViewType}
              data={result.data}
              groupBy={result.groupBy as GroupByType}
              onDataPointClick={handleDataPointClick}
              tableColumns={result.tableColumns}
              reportTitle={report.name}
              exportFilename={report.name
                .replace(/[^a-zA-Z0-9]/g, "-")
                .toLowerCase()}
            />
          ) : (
            <div className="py-12 text-center text-gray-500 dark:text-gray-400">
              {t("customReportViewer.noData")}
            </div>
          )}

          {/* Legend for pie/bar charts */}
          {(result.viewType === ReportViewType.PIE_CHART ||
            result.viewType === ReportViewType.BAR_CHART) &&
            legendData.length > 0 && (
              <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
                  {legendData.slice(0, 15).map((item, index) => (
                    <button
                      key={index}
                      onClick={() => item.id && handleDataPointClick(item.id)}
                      className="flex items-center gap-2 text-sm text-left hover:bg-gray-50 dark:hover:bg-gray-700 p-1 rounded"
                    >
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: item.color }}
                      />
                      <span className="text-gray-600 dark:text-gray-400 truncate">
                        {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
        </div>
      ) : null}
    </div>
  );
}
