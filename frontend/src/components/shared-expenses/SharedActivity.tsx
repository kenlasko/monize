"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { useReportData } from "@/hooks/useReportData";
import type { SharedGroupDetail } from "@/types/shared-expense";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { useDateFormat } from "@/hooks/useDateFormat";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { SharedError, SharedAmount } from "./SharedPrimitives";

export function SharedActivity({ group }: { group: SharedGroupDetail }) {
  const groupId = group.id;
  const t = useTranslations("sharedExpenses");
  const { formatDate } = useDateFormat();
  const [offset, setOffset] = useState(0);
  const key = `${groupId}:${offset}`;
  const data = useReportData(
    () => sharedExpensesApi.activity(groupId, offset),
    [key],
    { requestKey: key },
  );
  const fresh = data.dataKey === key && !data.isLoading && !data.error;
  return (
    <Card padding="md">
      <SharedError error={data.error} retry={data.reload} />
      {data.isLoading && <LoadingSpinner />}
      <ol className="space-y-4">
        {data.data?.items.map((item) => (
          <li
            key={item.id}
            className="border-b border-gray-100 dark:border-gray-700 pb-3"
          >
            <p className="font-medium">{t(item.action)}</p>
            {typeof item.detail.title === "string" && (
              <p className="break-words text-sm">{item.detail.title}</p>
            )}
            {typeof item.detail.reason === "string" && (
              <p className="break-words text-sm">{item.detail.reason}</p>
            )}
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t("activityBy", {
                actor: item.actorName,
                date: formatDate(item.createdAt),
              })}
            </p>
            {item.detail.previous !== null &&
              typeof item.detail.previous === "object" && (
                <Previous
                  group={group}
                  detail={item.detail.previous as Record<string, unknown>}
                />
              )}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 mt-4">
        <Button
          variant="outline"
          disabled={!fresh || !offset}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          {t("previousPage")}
        </Button>
        <Button
          variant="outline"
          disabled={!fresh || data.data?.nextOffset == null}
          onClick={() => setOffset(data.data!.nextOffset!)}
        >
          {t("loadMore")}
        </Button>
      </div>
    </Card>
  );
}
function Previous({
  detail,
  group,
}: {
  detail: Record<string, unknown>;
  group: SharedGroupDetail;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const allocations = Array.isArray(detail.allocations)
    ? detail.allocations.filter(
        (
          value,
        ): value is { participantId: string; kind: string; amount: string } =>
          !!value &&
          typeof value === "object" &&
          typeof value.participantId === "string" &&
          typeof value.amount === "string" &&
          (value.kind === "SHARE" || value.kind === "CONTRIBUTION"),
      )
    : [];
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer min-h-8">
        {t("previousVersion")}
      </summary>
      {typeof detail.title === "string" && (
        <p className="break-words">{detail.title}</p>
      )}
      {typeof detail.originalAmount === "string" &&
        typeof detail.currencyCode === "string" && (
          <SharedAmount
            amount={detail.originalAmount}
            currency={detail.currencyCode}
          />
        )}
      {typeof detail.date === "string" && <p>{formatDate(detail.date)}</p>}
      {typeof detail.fxRate === "string" && (
        <p>
          {t("fxRate")}: {formatNumber(Number(detail.fxRate), 10)}
        </p>
      )}
      {allocations.length > 0 && typeof detail.currencyCode === "string" && (
        <ul className="mt-2 space-y-1">
          {allocations.map((allocation) => (
            <li
              key={`${allocation.participantId}:${allocation.kind}`}
              className="flex flex-wrap justify-between gap-2"
            >
              <span>
                {group.participants.find(
                  (person) => person.id === allocation.participantId,
                )?.name ?? t("participantName")}{" "}
                ·{" "}
                {t(
                  allocation.kind === "SHARE" ? "shareAmount" : "paymentAmount",
                )}
              </span>
              <SharedAmount
                amount={allocation.amount}
                currency={detail.currencyCode as string}
              />
            </li>
          ))}
        </ul>
      )}
      {typeof detail.fromParticipantId === "string" &&
        typeof detail.toParticipantId === "string" && (
          <p>
            {
              group.participants.find(
                (person) => person.id === detail.fromParticipantId,
              )?.name
            }{" "}
            →{" "}
            {
              group.participants.find(
                (person) => person.id === detail.toParticipantId,
              )?.name
            }
          </p>
        )}
      {typeof detail.note === "string" && (
        <p className="break-words">{detail.note}</p>
      )}
    </details>
  );
}
