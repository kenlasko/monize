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
import { useDateFormat } from "@/hooks/useDateFormat";
import type { SharedEntry, SharedGroupDetail } from "@/types/shared-expense";
import { SharedAmount } from "./SharedPrimitives";
import { SharedEntryContext } from "./SharedEntryContext";

export function SharedEntryTable({
  group,
  fresh,
  onOpen,
  toolbar,
  emptyState,
}: {
  group: SharedGroupDetail;
  fresh: boolean;
  toolbar?: React.ReactNode;
  emptyState?: React.ReactNode;
  onOpen: (entry: SharedEntry) => void;
}) {
  const t = useTranslations("sharedExpenses");
  const { formatDate } = useDateFormat();
  const open = (entry: SharedEntry) => {
    if (fresh) onOpen(entry);
  };
  const { getRowHandlers } = useLongPress({
    onClick: open,
    onLongPress: open,
    enabled: fresh,
  });
  return (
    <Card className="overflow-hidden" aria-busy={!fresh}>
      {toolbar}
      {group.entries.length === 0 && emptyState ? (
        emptyState
      ) : (
        <table
          role="table"
          aria-label={t("expenses")}
          className={`${TABLE_CLASS} block sm:table w-full`}
        >
          <thead role="rowgroup" className="hidden sm:table-header-group">
            <tr role="row">
              <Th>{t("date")}</Th>
              <Th>{t("entryTitle")}</Th>
              <Th align="right">{t("amount")}</Th>
              <Th>{t("entryType")}</Th>
            </tr>
          </thead>
          <tbody
            role="rowgroup"
            className={`${TABLE_BODY_CLASS} block sm:table-row-group`}
          >
            {group.entries.map((entry) => (
              <tr
                key={entry.id}
                role="row"
                {...getRowHandlers(entry)}
                tabIndex={fresh ? 0 : -1}
                aria-disabled={!fresh}
                onKeyDown={activateOnKey(() => open(entry))}
                className={`grid grid-cols-2 sm:table-row ${HOVER_ROW_ON_CARD} ${fresh ? "cursor-pointer" : "opacity-60"} ${INTERACTIVE_ROW_FOCUS_CLASS}`}
              >
                <Td
                  role="cell"
                  className="col-start-1 row-start-2 sm:whitespace-nowrap"
                >
                  <CellLabel className={CAPTION_CLASS}>{t("date")}</CellLabel>
                  {formatDate(entry.date)}
                </Td>
                <Td
                  role="cell"
                  className="col-start-1 col-span-2 row-start-1 min-w-0 break-words sm:break-normal"
                >
                  <span className="font-medium">{entry.title}</span>
                  <SharedEntryContext entry={entry} group={group} />
                </Td>
                <Td
                  role="cell"
                  align="right"
                  className="col-start-1 col-span-2 row-start-3 sm:whitespace-nowrap"
                >
                  <CellLabel className={CAPTION_CLASS}>{t("amount")}</CellLabel>
                  <SharedAmount
                    amount={entry.originalAmount}
                    currency={entry.currencyCode}
                    relativeTo={group.currencyCode}
                    className="font-semibold"
                  />
                </Td>
                <Td role="cell" className="col-start-2 row-start-2 min-w-0">
                  <Badge variant={entry.state === "DRAFT" ? "amber" : "gray"}>
                    {t(entry.state === "POSTED" ? entry.type : entry.state)}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
