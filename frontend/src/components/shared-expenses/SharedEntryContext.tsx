"use client";

import { useTranslations } from "next-intl";
import type { SharedEntry, SharedGroupDetail } from "@/types/shared-expense";
import { SharedAmount } from "./SharedPrimitives";

export function SharedEntryContext({
  entry,
  group,
  prominent = false,
}: {
  entry: SharedEntry;
  group: SharedGroupDetail;
  prominent?: boolean;
}) {
  const t = useTranslations("sharedExpenses");
  const name = (id: string | null) =>
    group.participants.find((person) => person.id === id)?.name;
  if (entry.type === "REPAYMENT") {
    return (
      <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
        {name(entry.fromParticipantId)} → {name(entry.toParticipantId)}
      </p>
    );
  }
  const contributors = entry.allocations.filter(
    (allocation) =>
      allocation.kind === "CONTRIBUTION" &&
      Number(allocation.originalAmount) > 0,
  );
  return (
    <div
      className={`${prominent ? "" : "mt-2 "}text-sm text-gray-500 dark:text-gray-400 space-y-1`}
    >
      <p>
        {t(entry.type === "EXPENSE" ? "paidBy" : "receivedBy")} ·{" "}
        {contributors
          .map((allocation) => name(allocation.participantId))
          .join(", ")}
      </p>
      {entry.state === "POSTED" && (
        <p
          className={
            prominent
              ? "font-semibold text-gray-900 dark:text-gray-100"
              : undefined
          }
        >
          {t(
            entry.type === "INCOME"
              ? "yourIncome"
              : entry.type === "REFUND"
                ? "yourRefund"
                : "yourCost",
          )}{" "}
          ·{" "}
          <SharedAmount
            amount={
              entry.ownEffect
                ? String(Math.abs(Number(entry.ownEffect.personal)))
                : null
            }
            currency={group.currencyCode}
          />
        </p>
      )}
    </div>
  );
}
