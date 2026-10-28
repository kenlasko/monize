"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { DateInput } from "@/components/ui/DateInput";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  TABLE_CLASS,
  TABLE_BODY_CLASS,
  Th,
  Td,
  CellLabel,
  CAPTION_CLASS,
} from "@/components/ui/Table";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useReportData } from "@/hooks/useReportData";
import {
  reportingDetailsApi,
  type ReportingDetailsInput,
} from "@/lib/reporting-details";

export function RecognitionDetailsDialog({
  input,
  onClose,
}: {
  input: ReportingDetailsInput | null;
  onClose: () => void;
}) {
  const t = useTranslations("common.recognitionDetails");
  const tc = useTranslations("common");
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [startDate, setStartDate] = useState(input?.startDate ?? "0001-01-01");
  const [endDate, setEndDate] = useState(input?.endDate ?? "9999-12-31");
  const query = input ? { ...input, startDate, endDate } : null;
  const key = JSON.stringify(query);
  const { data, isLoading, error, reload } = useReportData(
    () => (query ? reportingDetailsApi.get(query) : Promise.resolve(null)),
    [key],
    { requestKey: key, maskStaleData: true },
  );
  return (
    <Modal
      padding="md"
      isOpen
      title={t("title")}
      onClose={onClose}
      maxWidth="3xl"
    >
      <div className="space-y-4">
        <p>{t("help")}</p>
        {input && (
          <div className="grid gap-3 sm:grid-cols-2">
            <DateInput
              label={t("start")}
              value={startDate}
              onDateChange={setStartDate}
            />
            <DateInput
              label={t("end")}
              value={endDate}
              onDateChange={setEndDate}
            />
          </div>
        )}
        {!input ? (
          <p role="alert">{t("unsupported")}</p>
        ) : isLoading ? (
          <p role="status">{tc("loading")}</p>
        ) : error ? (
          <div role="alert">
            <p>{t("failed")}</p>
            <Button onClick={reload}>{t("retry")}</Button>
          </div>
        ) : (
          data && (
            <>
              <p>
                {formatCurrency(data.knownSubtotal, data.currency, 4)}{" "}
                {data.fxComplete ? data.currency : t("partial")}
              </p>
              {!data.fxComplete && <p role="alert">{t("fxHelp")}</p>}
              {!data.rows.length ? (
                <EmptyState title={t("empty")} />
              ) : (
                <div className="max-h-96 overflow-auto scrollbar-slim">
                  <table
                    role="table"
                    className={`${TABLE_CLASS} block sm:table`}
                  >
                    <thead
                      role="rowgroup"
                      className="hidden sm:table-header-group"
                    >
                      <tr role="row">
                        <Th>{t("effective")}</Th>
                        <Th>{t("payment")}</Th>
                        <Th>{t("native")}</Th>
                        <Th>{t("reporting")}</Th>
                        <Th>{t("source")}</Th>
                      </tr>
                    </thead>
                    <tbody
                      role="rowgroup"
                      className={`${TABLE_BODY_CLASS} block sm:table-row-group`}
                    >
                      {data.rows.map((row) => (
                        <tr
                          role="row"
                          className="grid grid-cols-1 gap-2 py-3 sm:table-row sm:py-0"
                          key={`${row.sourceTransactionId}:${row.sourceSplitId}:${row.scheduleId}:${row.effectiveDate}`}
                        >
                          <Td
                            role="cell"
                            className="col-start-1 row-start-1 block whitespace-nowrap sm:table-cell"
                          >
                            <CellLabel className={CAPTION_CLASS}>
                              {t("effective")}
                            </CellLabel>
                            {formatDate(row.effectiveDate)}
                          </Td>
                          <Td
                            role="cell"
                            className="col-start-1 row-start-2 block whitespace-nowrap sm:table-cell"
                          >
                            <CellLabel className={CAPTION_CLASS}>
                              {t("payment")}
                            </CellLabel>
                            {formatDate(row.cashDate)}
                          </Td>
                          <Td
                            role="cell"
                            className="col-start-1 row-start-3 block whitespace-nowrap sm:table-cell"
                          >
                            <CellLabel className={CAPTION_CLASS}>
                              {t("native")}
                            </CellLabel>
                            {formatCurrency(
                              Number(row.nativeAmount),
                              row.currencyCode,
                              4,
                            )}{" "}
                            {row.currencyCode}
                          </Td>
                          <Td
                            role="cell"
                            className="col-start-1 row-start-4 block sm:table-cell"
                          >
                            <CellLabel className={CAPTION_CLASS}>
                              {t("reporting")}
                            </CellLabel>
                            {row.convertedAmount === null
                              ? t("unknown")
                              : formatCurrency(
                                  row.convertedAmount,
                                  data.currency,
                                  4,
                                )}
                          </Td>
                          <Td
                            role="cell"
                            className="col-start-1 row-start-5 block min-w-0 sm:table-cell"
                          >
                            <CellLabel className={CAPTION_CLASS}>
                              {t("source")}
                            </CellLabel>
                            <Link
                              href={`/transactions?basis=cash&accountId=${row.accountId}&startDate=${row.cashDate}&endDate=${row.cashDate}&accountStatus=all&highlightTransactionId=${row.sourceTransactionId}`}
                              className="text-blue-600 focus-visible:outline-2"
                            >
                              {t("source")}
                            </Link>
                            <details>
                              <summary>{t("identity")}</summary>
                              <p className="break-all">
                                {row.sourceTransactionId}
                              </p>
                              {row.sourceSplitId && (
                                <p className="break-all">{row.sourceSplitId}</p>
                              )}
                              {row.scheduleId && (
                                <p className="break-all">{row.scheduleId}</p>
                              )}
                            </details>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )
        )}
        <Button variant="secondary" onClick={onClose}>
          {tc("close")}
        </Button>
      </div>
    </Modal>
  );
}
