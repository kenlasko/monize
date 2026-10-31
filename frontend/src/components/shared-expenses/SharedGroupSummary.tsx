"use client";

import { useTranslations } from "next-intl";
import { SummaryCardGrid } from "@/components/accounts/shared/SummaryCardGrid";
import {
  BanknotesIcon,
  UserIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";
import type { SharedGroupDetail } from "@/types/shared-expense";
import { SharedAmount } from "./SharedPrimitives";
import {
  SharedPositionValue,
  sharedPositionCaption,
} from "./SharedPositionValue";

export function SharedGroupSummary({ group }: { group: SharedGroupDetail }) {
  const t = useTranslations("sharedExpenses");
  const mine = group.balances.positions.find(
    (person) => person.participantId === group.myParticipantId,
  );
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {t("groupCurrencySummary", { currency: group.currencyCode })}
      </p>
      <SummaryCardGrid
        className="grid grid-cols-1 gap-4 sm:grid-cols-3"
        cards={[
          {
            label: t(sharedPositionCaption(mine?.balance ?? null, true)),
            icon: <BanknotesIcon className="h-5 w-5" />,
            value: (
              <SharedPositionValue
                personal
                hideCaption
                amount={mine?.balance ?? null}
                currency={group.currencyCode}
              />
            ),
          },
          {
            label: t("yourCost"),
            icon: <UserIcon className="h-5 w-5" />,
            value: (
              <SharedAmount
                amount={mine?.cost ?? null}
                currency={group.currencyCode}
              />
            ),
            note: (
              <>
                {t("youPaid")} ·{" "}
                <SharedAmount
                  amount={mine?.paid ?? null}
                  currency={group.currencyCode}
                />
              </>
            ),
          },
          {
            label: t("totalExpenses"),
            icon: <UserGroupIcon className="h-5 w-5" />,
            value: (
              <SharedAmount
                amount={group.balances.totalExpenses}
                currency={group.currencyCode}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
