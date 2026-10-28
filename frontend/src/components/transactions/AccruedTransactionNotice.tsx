"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AccrualDialog } from "./AccrualDialog";
import { useAccrualBadges } from "./useAccrualBadges";

/** Opens the saved source's schedule without replacing or submitting its editor. */
export function AccruedTransactionNotice({
  sourceId,
  onChanged,
}: {
  sourceId: string;
  onChanged?: () => void;
}) {
  const t = useTranslations("transactions.accrual");
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const badges = useAccrualBadges([sourceId], revision);
  const count = badges.counts?.get(sourceId);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t("title")}
        {count !== undefined && count > 0 && (
          <span className="ml-2">
            <Badge>{t("existing")}</Badge>
          </span>
        )}
      </Button>
      {badges.failed && (
        <div role="alert">
          <p>{t("failed")}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={badges.retry}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {open && (
        <div className="basis-full w-full order-last">
          <AccrualDialog
            key={`${sourceId}:${revision}`}
            embedded
            transactionId={sourceId}
            onClose={() => setOpen(false)}
            onSaved={() => {
              setRevision((value) => value + 1);
              onChanged?.();
            }}
          />
        </div>
      )}
    </>
  );
}
