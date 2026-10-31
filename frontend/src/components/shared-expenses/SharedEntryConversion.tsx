"use client";

import { useTranslations } from "next-intl";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { FX_RATE_DISPLAY_DECIMALS } from "@/lib/format";
import type { SharedEntry, SharedGroupDetail } from "@/types/shared-expense";
import { SharedAmount } from "./SharedPrimitives";

const sources = ["MANUAL", "MARKET", "ORIGINAL_REFUND"] as const;

/** Read the server's snapshot; a current market lookup would reprice the entry. */
export function SharedEntryConversion({
  entry,
  group,
}: {
  entry: SharedEntry;
  group: SharedGroupDetail;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  if (entry.currencyCode === group.currencyCode) return null;
  const source = sources.find((value) => value === entry.fxSource);
  return (
    <section aria-label={t("currencyConversion")} className="space-y-2 text-sm">
      <dl className="flex flex-wrap justify-between gap-3">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">
            {t("groupAmount")} · {group.currencyCode}
          </dt>
          <dd className="font-semibold">
            <SharedAmount
              amount={entry.groupAmount}
              currency={group.currencyCode}
            />
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">{t("fxRate")}</dt>
          <dd>
            {entry.fxRate === null
              ? t("unknown")
              : t("fxRateValue", {
                  one: formatNumber(1, 0),
                  from: entry.currencyCode,
                  rate: formatNumber(
                    Number(entry.fxRate),
                    FX_RATE_DISPLAY_DECIMALS,
                  ),
                  to: group.currencyCode,
                })}
          </dd>
        </div>
      </dl>
      {entry.fxRate !== null && (
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-gray-500 dark:text-gray-400">
          <div className="flex gap-1">
            <dt>{t("fxSource")}:</dt>
            <dd>{source ? t(source) : t("unknown")}</dd>
          </div>
          {entry.fxRateDate !== null && (
            <div className="flex gap-1">
              <dt>{t("fxRateDate")}:</dt>
              <dd>{formatDate(entry.fxRateDate)}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
