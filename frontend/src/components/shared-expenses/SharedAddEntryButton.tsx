"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDownIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/Button";
import { HOVER_ROW_ON_CARD } from "@/components/ui/Card";
import { useClickOutside } from "@/hooks/useClickOutside";

/** Uses the Investments transaction-action dropdown pattern. */
export function SharedAddEntryButton({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (kind: "EXPENSE" | "INCOME") => void;
}) {
  const t = useTranslations("sharedExpenses");
  const [open, setOpen] = useState(false);
  const dropdown = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(dropdown, close, {
    enabled: open,
    onEscape: () => {
      close();
      trigger.current?.focus();
    },
  });

  return (
    <div ref={dropdown} className="relative flex-1 sm:flex-none">
      <Button
        ref={trigger}
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open && !disabled}
        className="w-full whitespace-nowrap"
        onClick={() => setOpen(!open)}
      >
        <PlusIcon aria-hidden="true" className="mr-2 h-5 w-5" />
        {t("addExpense")}
        <ChevronDownIcon aria-hidden="true" className="ml-2 h-4 w-4" />
      </Button>
      {open && !disabled && (
        <div className="absolute right-0 z-50 mt-1 w-full min-w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800">
          {(["EXPENSE", "INCOME"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`${HOVER_ROW_ON_CARD} min-h-11 w-full px-4 py-2 text-left text-sm text-gray-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 dark:text-gray-300`}
              onClick={() => {
                close();
                onAdd(kind);
              }}
            >
              {t(kind)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
