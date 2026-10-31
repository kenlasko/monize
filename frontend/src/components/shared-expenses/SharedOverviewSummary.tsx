"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import { SummaryCardGrid } from "@/components/accounts/shared/SummaryCardGrid";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import type { sharedExpensesApi } from "@/lib/shared-expenses";
import { SharedAmount } from "./SharedPrimitives";

type Overview = Awaited<ReturnType<typeof sharedExpensesApi.overview>>;
export function SharedOverviewSummary({ overview }: { overview: Overview }) {
  const t = useTranslations("sharedExpenses");
  const { formatNumber } = useNumberFormat();
  return (
    <section aria-label={t("totalsByCurrency")} className="space-y-3">
      <SummaryCardGrid
        className="grid grid-cols-1 gap-4 sm:grid-cols-3"
        cards={[
          {
            label: t("overallReceivable"),
            icon: <ArrowDownLeftIcon className="h-5 w-5" />,
            value: overview.totals.length
              ? overview.totals.map((total) => (
                  <div key={total.currencyCode}>
                    <SharedAmount
                      amount={total.receivable}
                      currency={total.currencyCode}
                      relativeTo=""
                    />
                  </div>
                ))
              : t("none"),
          },
          {
            label: t("overallPayable"),
            icon: <ArrowUpRightIcon className="h-5 w-5" />,
            value: overview.totals.length
              ? overview.totals.map((total) => (
                  <div key={total.currencyCode}>
                    <SharedAmount
                      amount={total.payable}
                      currency={total.currencyCode}
                      relativeTo=""
                    />
                  </div>
                ))
              : t("none"),
          },
          {
            label: t("groups"),
            icon: <UserGroupIcon className="h-5 w-5" />,
            value: formatNumber(overview.groups.length, 0),
          },
        ]}
      />
      {overview.totals
        .filter((total) => total.unresolvedGroupIds.length)
        .map((total) => (
          <div key={total.currencyCode} className="text-sm">
            <p>{t("summaryUnknown")}</p>
            <ul className="flex flex-wrap gap-3">
              {total.unresolvedGroupIds.map((id) => (
                <li key={id}>
                  <Link
                    href={`/shared-expenses/${id}`}
                    className="text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    {overview.groups.find((group) => group.id === id)?.name ??
                      id}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
