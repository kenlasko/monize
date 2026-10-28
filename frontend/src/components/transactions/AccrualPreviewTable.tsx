"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { TABLE_CLASS, TABLE_BODY_CLASS, Th, Td } from "@/components/ui/Table";
import type { AccrualPlan, AccrualPreview } from "@/lib/accruals";

export function AccrualPlanTable({
  plan,
  currency,
  highlightDate,
}: {
  plan: AccrualPlan;
  currency: string;
  highlightDate?: string;
}) {
  const t = useTranslations("transactions.accrual");
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  const selectedRow = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    selectedRow.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlightDate]);
  return (
    <div className="max-h-64 overflow-auto">
      <table className={TABLE_CLASS}>
        <caption className="text-left text-sm font-medium">{currency}</caption>
        <thead>
          <tr>
            <Th>{t("recognition")}</Th>
            <Th>{t("amount")}</Th>
          </tr>
        </thead>
        <tbody className={TABLE_BODY_CLASS}>
          {plan.allocations.map((row) => (
            <tr
              ref={
                row.recognitionDate === highlightDate ? selectedRow : undefined
              }
              key={row.periodIndex}
              aria-selected={row.recognitionDate === highlightDate || undefined}
              className={
                row.recognitionDate === highlightDate
                  ? "bg-blue-50 dark:bg-blue-950"
                  : undefined
              }
            >
              <Td>{formatDate(row.recognitionDate)}</Td>
              <Td>{formatCurrency(Number(row.amount), currency, 4)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AccrualPreviewTable({
  preview,
  highlightDate,
}: {
  preview: AccrualPreview;
  highlightDate?: string;
}) {
  const t = useTranslations("transactions.accrual");
  const th = useTranslations("transactions.list.header");
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();
  return (
    <div className="space-y-4" aria-live="polite">
      <p>
        {t("source", {
          date: formatDate(preview.source.paymentDate),
          amount: formatCurrency(
            Number(preview.source.amount),
            preview.source.currencyCode,
            4,
          ),
        })}
      </p>
      {preview.before && (
        <details>
          <summary>{t("existing")}</summary>
          <AccrualPlanTable
            plan={preview.before}
            currency={preview.source.currencyCode}
          />
        </details>
      )}
      <AccrualPlanTable
        highlightDate={highlightDate}
        plan={preview.plan}
        currency={preview.source.currencyCode}
      />
      <details>
        <summary>
          {t(preview.family === "expense" ? "prepaid" : "unearned")}
        </summary>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t("balanceHelp")}
        </p>
        <div className="max-h-64 overflow-auto">
          <table className={TABLE_CLASS}>
            <caption className="text-left text-sm font-medium">
              {preview.source.currencyCode}
            </caption>
            <thead>
              <tr>
                <Th>{th("date")}</Th>
                <Th>{t("amount")}</Th>
              </tr>
            </thead>
            <tbody className={TABLE_BODY_CLASS}>
              {preview.timingBalances.map((row) => (
                <tr key={row.asOf}>
                  <Td>{formatDate(row.asOf)}</Td>
                  <Td>
                    {formatCurrency(
                      Number(row.amount),
                      preview.source.currencyCode,
                      4,
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
