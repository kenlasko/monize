"use client";

import { useTranslations } from "next-intl";
import { Card, HOVER_ROW_ON_CARD } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  CellLabel,
  CAPTION_CLASS,
  TABLE_CLASS,
  TABLE_BODY_CLASS,
  Th,
  Td,
} from "@/components/ui/Table";
import {
  activateOnKey,
  INTERACTIVE_ROW_FOCUS_CLASS,
} from "@/components/ui/interactive-row";
import { useLongPress } from "@/hooks/useLongPress";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import type { SharedGroup } from "@/types/shared-expense";
import { SharedPositionValue } from "./SharedPositionValue";

export function SharedGroupTable({
  groups,
  fresh,
  onOpen,
  toolbar,
}: {
  groups: SharedGroup[];
  fresh: boolean;
  toolbar?: React.ReactNode;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatNumber } = useNumberFormat();
  const open = (group: SharedGroup) => {
    if (fresh) onOpen(group.id);
  };
  const { getRowHandlers } = useLongPress({
    onClick: open,
    onLongPress: open,
    enabled: fresh,
  });
  return (
    <Card className="overflow-hidden" aria-busy={!fresh}>
      {toolbar}
      <table
        role="table"
        aria-label={t("groups")}
        className={`${TABLE_CLASS} block sm:table w-full`}
      >
        <thead role="rowgroup" className="hidden sm:table-header-group">
          <tr role="row">
            <Th>{t("groups")}</Th>
            <Th>{t("participants")}</Th>
            <Th>{t("currency")}</Th>
            <Th align="right">{t("yourBalance")}</Th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          className={`${TABLE_BODY_CLASS} block sm:table-row-group`}
        >
          {groups.map((group) => (
            <tr
              key={group.id}
              role="row"
              {...getRowHandlers(group)}
              tabIndex={fresh ? 0 : -1}
              aria-disabled={!fresh}
              onKeyDown={activateOnKey(() => open(group))}
              className={`grid grid-cols-2 sm:table-row ${HOVER_ROW_ON_CARD} ${fresh ? "cursor-pointer" : "opacity-60"} ${INTERACTIVE_ROW_FOCUS_CLASS}`}
            >
              <Td
                role="cell"
                className="col-start-1 col-span-2 row-start-1 min-w-0 break-words sm:break-normal"
              >
                <span className="font-medium">{group.name}</span>
                {!group.settlementReady && (
                  <p className="text-sm mt-1">{t("missingRate")}</p>
                )}
              </Td>
              <Td role="cell" className="col-start-1 row-start-2">
                <CellLabel className={CAPTION_CLASS}>
                  {t("participants")}
                </CellLabel>
                {formatNumber(group.participantCount, 0)}
              </Td>
              <Td role="cell" className="col-start-2 row-start-2">
                <CellLabel className={CAPTION_CLASS}>{t("currency")}</CellLabel>
                <Badge>{group.currencyCode}</Badge>
              </Td>
              <Td
                role="cell"
                align="right"
                className="col-start-1 col-span-2 row-start-3 min-w-0"
              >
                <SharedPositionValue
                  personal
                  amount={group.myPosition?.balance ?? null}
                  currency={group.currencyCode}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
