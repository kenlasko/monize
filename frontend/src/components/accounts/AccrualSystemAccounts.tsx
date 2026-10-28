"use client";
import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAuthStore } from "@/store/authStore";
import { useFinancialToday } from "@/hooks/useFinancialToday";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useReportData } from "@/hooks/useReportData";
import { useOnUndoRedo } from "@/hooks/useOnUndoRedo";
import { useOnAiAction } from "@/hooks/useOnAiAction";
import { accrualsApi, type AccrualSystemMovements } from "@/lib/accruals";
import { exportToCsv } from "@/lib/csv-export";
import { PageHeader } from "@/components/layout/PageHeader";
import { DateInput } from "@/components/ui/DateInput";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { TABLE_CLASS, TABLE_BODY_CLASS, Th, Td } from "@/components/ui/Table";
import { ReportToolbarActions } from "@/components/reports/ReportToolbarActions";
export function AccrualSystemAccounts({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const t = useTranslations("common.systemAccruals");
  const acting = useAuthStore((s) => s.actingAsUserId);
  return acting ? (
    <p role="alert">{t("ownerOnly")}</p>
  ) : (
    <SystemAccountContent embedded={embedded} />
  );
}
function SystemAccountContent({ embedded }: { embedded: boolean }) {
  const t = useTranslations("common.systemAccruals");
  const tc = useTranslations("common.recognitionDetails");
  const common = useTranslations("common");
  const today = useFinancialToday();
  const [asOf, setAsOf] = useState(today);
  const [startDate, setStartDate] = useState(today.slice(0, 7) + "-01");
  const [chosen, setChosen] = useState("");
  const { formatCurrency } = useNumberFormat();
  const { data, isLoading, error, reload } = useReportData(
    () => accrualsApi.systemBalances(asOf),
    [asOf],
    { requestKey: asOf, maskStaleData: true },
  );
  useOnUndoRedo(reload);
  useOnAiAction(reload);
  const accounts = data?.accounts ?? [];
  const selected = accounts.find((a) => a.id === chosen) ?? accounts[0];
  return (
    <div className="space-y-4">
      {!embedded && <PageHeader title={t("title")} subtitle={t("help")} />}
      {embedded && <p>{t("help")}</p>}
      {!embedded && (
        <Link
          href="/accounts"
          className="text-blue-600 focus-visible:outline-2"
        >
          {t("back")}
        </Link>
      )}
      <DateInput
        label={t("asOf")}
        value={asOf}
        onDateChange={(value) => {
          setAsOf(value);
          setStartDate(value.slice(0, 7) + "-01");
        }}
      />
      {isLoading ? (
        <p role="status">{common("loading")}</p>
      ) : error ? (
        <div role="alert">
          <p>{tc("failed")}</p>
          <Button onClick={reload}>{tc("retry")}</Button>
        </div>
      ) : !accounts.length ? (
        <EmptyState title={t("empty")} />
      ) : (
        <>
          <Card>
            <div className="overflow-auto">
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <Th>{t("account")}</Th>
                    <Th>{t("currency")}</Th>
                    <Th>{t("balance")}</Th>
                    <Th>{t("position")}</Th>
                  </tr>
                </thead>
                <tbody className={TABLE_BODY_CLASS}>
                  {accounts.map((a) => (
                    <tr key={a.id}>
                      <Td>
                        {t(a.family === "expense" ? "prepaid" : "unearned")}
                      </Td>
                      <Td>{a.currencyCode}</Td>
                      <Td>
                        {formatCurrency(Number(a.balance), a.currencyCode, 4)}
                      </Td>
                      <Td>
                        <Badge>
                          {t(
                            (a.family === "expense") === Number(a.balance) >= 0
                              ? "asset"
                              : "liability",
                          )}
                        </Badge>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <p>{t("signHelp")}</p>
          <Select
            label={t("account")}
            value={selected?.id ?? ""}
            onChange={(event) => setChosen(event.target.value)}
            options={accounts.map((a) => ({
              value: a.id,
              label:
                t(a.family === "expense" ? "prepaid" : "unearned") +
                " · " +
                a.currencyCode,
            }))}
          />
          <DateInput
            label={tc("start")}
            value={startDate}
            onDateChange={setStartDate}
          />
          {selected && (
            <MovementDetails
              key={selected.id}
              id={selected.id}
              startDate={startDate}
              endDate={asOf}
            />
          )}
        </>
      )}
    </div>
  );
}
function MovementDetails({
  id,
  startDate,
  endDate,
}: {
  id: string;
  startDate: string;
  endDate: string;
}) {
  const t = useTranslations("common.systemAccruals");
  const tc = useTranslations("common.recognitionDetails");
  const common = useTranslations("common");
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const key = JSON.stringify([id, startDate, endDate]);
  const { data, isLoading, error, reload } = useReportData(
    () => accrualsApi.systemMovements(id, startDate, endDate),
    [key],
    { requestKey: key, maskStaleData: true },
  );
  useOnUndoRedo(reload);
  useOnAiAction(reload);
  const renderData = (data: AccrualSystemMovements) => {
    const currency = data.account.currencyCode;
    const exportRows = () =>
      exportToCsv(
        "accrual-system-movements",
        [
          t("asOf"),
          t("account"),
          t("currency"),
          t("opening"),
          t("closing"),
          t("date"),
          t("movement"),
          t("amount"),
          tc("identity"),
        ],
        data.rows.map((row) => [
          endDate,
          t(data.account.family === "expense" ? "prepaid" : "unearned"),
          currency,
          data.opening,
          data.closing,
          row.date,
          t(row.kind),
          row.amount,
          [row.sourceTransactionId, row.sourceSplitId, row.scheduleId]
            .filter(Boolean)
            .join(" / "),
        ]),
      );
    return (
      <div className="space-y-4">
        <p>
          {t("range", {
            start: formatDate(startDate),
            end: formatDate(endDate),
          })}
        </p>
        <p>
          {t("opening")}: {formatCurrency(Number(data.opening), currency, 4)}{" "}
          {currency}
        </p>
        <p>
          {t("closing")}: {formatCurrency(Number(data.closing), currency, 4)}{" "}
          {currency}
        </p>
        <ReportToolbarActions
          onExportCsv={exportRows}
          disabled={!data.rows.length}
        />
        {!data.rows.length ? (
          <EmptyState title={tc("empty")} />
        ) : (
          <div className="overflow-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th>{t("date")}</Th>
                  <Th>{t("movement")}</Th>
                  <Th>{t("amount")}</Th>
                  <Th>{tc("source")}</Th>
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                {data.rows.map((row) => (
                  <tr key={`${row.scheduleId}:${row.kind}:${row.date}`}>
                    <Td>{formatDate(row.date)}</Td>
                    <Td>{t(row.kind)}</Td>
                    <Td>
                      {formatCurrency(Number(row.amount), currency, 4)}{" "}
                      {currency}
                    </Td>
                    <Td>
                      <Link
                        href={`/transactions?basis=cash&accountId=${row.accountId}&startDate=${row.cashDate}&endDate=${row.cashDate}&accountStatus=all&highlightTransactionId=${row.sourceTransactionId}`}
                        className="text-blue-600 focus-visible:outline-2"
                      >
                        {tc("source")}
                      </Link>
                      <details>
                        <summary>{tc("identity")}</summary>
                        <p className="break-all">{row.sourceTransactionId}</p>
                        {row.sourceSplitId && (
                          <p className="break-all">{row.sourceSplitId}</p>
                        )}
                        <p className="break-all">{row.scheduleId}</p>
                      </details>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };
  return (
    <Card>
      {isLoading ? (
        <p role="status">{common("loading")}</p>
      ) : error ? (
        <div role="alert">
          <p>{tc("failed")}</p>
          <Button onClick={reload}>{tc("retry")}</Button>
        </div>
      ) : data ? (
        renderData(data)
      ) : null}
    </Card>
  );
}
