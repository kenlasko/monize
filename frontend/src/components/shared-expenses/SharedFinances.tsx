"use client";

import { useTranslations } from "next-intl";
import type { SharedGroupDetail } from "@/types/shared-expense";
import { SharedPrivateFinances } from "./SharedPrivateFinances";
import { SharedNotice } from "./SharedPrimitives";

/** Compatibility view for records accepted by an earlier draft. */
export function SharedFinances({
  group,
}: {
  group: SharedGroupDetail;
  onEnabled?: () => void;
  onOpenEntry?: (entryId: string) => void;
}) {
  const t = useTranslations("sharedExpenses");
  return (
    <div className="space-y-4">
      <SharedNotice>{t("financeDeferred")}</SharedNotice>
      <SharedPrivateFinances
        key={group.id}
        initialGroupId={group.id}
        revision={group.revision}
      />
    </div>
  );
}
