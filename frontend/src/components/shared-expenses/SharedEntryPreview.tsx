"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import type { SharedEntry, SharedGroupDetail } from "@/types/shared-expense";
import { SharedAmount, SharedNotice } from "./SharedPrimitives";
import { SharedEntryContext } from "./SharedEntryContext";
import { SharedEntryConversion } from "./SharedEntryConversion";

export function SharedEntryPreview({
  entry,
  group,
  compact = false,
}: {
  entry: SharedEntry;
  group: SharedGroupDetail;
  compact?: boolean;
}) {
  const t = useTranslations("sharedExpenses");
  const [expanded, setExpanded] = useState(
    entry.splitMode !== "EQUAL" || !group.myParticipantId,
  );
  const shares = entry.allocations.filter(
    (allocation) => allocation.kind === "SHARE",
  );
  const allocations = (
    <ul className="space-y-2">
      {shares.map((allocation) => (
        <li
          key={allocation.participantId}
          className="flex flex-wrap justify-between gap-2"
        >
          <span className="break-words min-w-0">
            {
              group.participants.find(
                (person) => person.id === allocation.participantId,
              )?.name
            }
          </span>
          <span>
            <SharedAmount
              amount={allocation.originalAmount}
              currency={entry.currencyCode}
              relativeTo={group.currencyCode}
            />
            {entry.currencyCode !== group.currencyCode && (
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                <SharedAmount
                  amount={allocation.groupAmount}
                  currency={group.currencyCode}
                />
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <Card padding="sm" className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{t("review")}</h3>
        <InfoTooltip text={t("previewHelp")} usePortal />
      </div>
      {entry.draftReason && (
        <SharedNotice>
          {entry.draftReason === "MISSING_RATE"
            ? t("MISSING_RATE", {
                from: entry.currencyCode,
                to: group.currencyCode,
                date: entry.date,
              })
            : t("FUTURE_DATE")}
        </SharedNotice>
      )}
      <SharedEntryConversion entry={entry} group={group} />
      {entry.type === "REPAYMENT" && (
        <p>
          {
            group.participants.find(
              (person) => person.id === entry.fromParticipantId,
            )?.name
          }{" "}
          →{" "}
          {
            group.participants.find(
              (person) => person.id === entry.toParticipantId,
            )?.name
          }
          :{" "}
          <SharedAmount
            amount={entry.originalAmount}
            currency={entry.currencyCode}
            relativeTo={group.currencyCode}
          />
        </p>
      )}
      {group.myParticipantId && (
        <div className="grid grid-cols-1 min-[360px]:grid-cols-2 gap-3">
          {entry.type !== "REPAYMENT" && (
            <SharedEntryContext entry={entry} group={group} prominent />
          )}
          <dl>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              {t("settlementChange")}
            </dt>
            <dd className="font-semibold">
              <SharedAmount
                amount={entry.ownEffect?.position ?? null}
                currency={group.currencyCode}
              />
            </dd>
          </dl>
        </div>
      )}
      {entry.type !== "REPAYMENT" &&
        (compact ? (
          <details
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary
              className="cursor-pointer min-h-10 py-2 text-sm"
              onClick={(event) => {
                event.preventDefault();
                setExpanded(!expanded);
              }}
            >
              {entry.splitMode === "EQUAL"
                ? t("equalSummary", { count: shares.length })
                : t(entry.splitMode)}
            </summary>
            {allocations}
          </details>
        ) : (
          allocations
        ))}
    </Card>
  );
}
