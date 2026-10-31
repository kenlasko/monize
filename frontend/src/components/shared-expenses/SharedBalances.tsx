"use client";

import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import type {
  SharedGroupDetail,
  SharedSuggestion,
} from "@/types/shared-expense";
import { SharedPositionValue } from "./SharedPositionValue";
import { SharedReminder } from "./SharedReminder";
import { SharedAmount, SharedNotice } from "./SharedPrimitives";

export function SharedBalances({
  group,
  onRepay,
}: {
  group: SharedGroupDetail;
  onRepay: (suggestion?: SharedSuggestion) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const writable = group.role !== "VIEWER" && !group.archivedAt;
  const name = (id: string) =>
    group.participants.find((p) => p.id === id)?.name;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card padding="md">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">{t("suggestions")}</h2>
          <InfoTooltip text={t("repaymentExplanation")} usePortal />
        </div>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t("suggestionsHelp")}
        </p>
        {!group.balances.settlementReady ? (
          <div className="mt-4">
            <SharedNotice>{t("missingRate")}</SharedNotice>
          </div>
        ) : group.balances.suggestions.length === 0 ? (
          <EmptyState title={t("noRepayments")} />
        ) : (
          <ul className="mt-4 divide-y divide-gray-100 dark:divide-gray-700">
            {group.balances.suggestions.map((row) => (
              <li
                key={`${row.fromParticipantId}:${row.toParticipantId}`}
                className="py-4 space-y-2"
              >
                <p className="break-words">
                  {name(row.fromParticipantId)} → {name(row.toParticipantId)}
                </p>
                {writable &&
                  !group.isDetachedCopy &&
                  row.fromParticipantId !== group.myParticipantId &&
                  group.participants.some(
                    (p) => p.id === row.fromParticipantId && p.connected,
                  ) && (
                    <SharedReminder
                      group={group}
                      participantId={row.fromParticipantId}
                    />
                  )}
                <div className="flex flex-wrap justify-between gap-3 items-center">
                  <SharedAmount
                    className="text-xl font-semibold"
                    amount={row.amount}
                    currency={group.currencyCode}
                  />
                  {writable && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onRepay(row)}
                    >
                      {t("addRepayment")}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {writable && group.balances.settlementReady && (
          <Button variant="outline" className="mt-3" onClick={() => onRepay()}>
            {t("otherRepayment")}
          </Button>
        )}
      </Card>
      <Card padding="md">
        <h2 className="text-lg font-semibold">{t("positions")}</h2>
        <ul className="mt-4 space-y-4">
          {group.balances.positions.map((position) => (
            <li
              key={position.participantId}
              className="border-b border-gray-100 dark:border-gray-700 pb-4"
            >
              <div className="flex flex-wrap justify-between gap-2 font-medium">
                <span className="break-words">
                  {name(position.participantId)}
                </span>
                <SharedPositionValue
                  amount={position.balance}
                  currency={group.currencyCode}
                />
              </div>
              <details className="mt-2 text-sm">
                <summary className="cursor-pointer text-gray-500 dark:text-gray-400 min-h-8">
                  {t("review")}
                </summary>
                <dl className="grid grid-cols-2 gap-2 mt-2">
                  {(
                    ["paid", "cost", "income", "sent", "received"] as const
                  ).map((field) => (
                    <div key={field}>
                      <dt className="text-xs text-gray-500 dark:text-gray-400">
                        {t(field)}
                      </dt>
                      <dd>
                        <SharedAmount
                          amount={position[field]}
                          currency={group.currencyCode}
                        />
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
