"use client";

import { useTranslations } from "next-intl";
import { ChevronDownIcon, FunnelIcon } from "@heroicons/react/24/outline";
import { Badge } from "./Badge";
import { useNumberFormat } from "@/hooks/useNumberFormat";

/** Shared presentation; each list owns its filters and request identity. */
export function FilterPanelHeader({
  expanded,
  count,
  onToggle,
  onClear,
}: {
  expanded: boolean;
  count: number;
  onToggle: () => void;
  onClear: () => void;
}) {
  const t = useTranslations("transactions");
  const { formatNumber } = useNumberFormat();
  return (
    <div className="flex items-center justify-between gap-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex flex-1 min-w-0 items-center gap-2 min-h-10 text-left focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
      >
        <FunnelIcon className="w-5 h-5 text-gray-500 dark:text-gray-400 shrink-0" />
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t("filter.panel.title")}
        </span>
        {count > 0 && <Badge variant="blue">{formatNumber(count, 0)}</Badge>}
        <span className="ml-auto flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400">
          {expanded ? t("filter.panel.hide") : t("filter.panel.show")}
          <ChevronDownIcon
            className={`w-4 h-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {count > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="min-h-10 text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        >
          {t("filter.panel.clear")}
        </button>
      )}
    </div>
  );
}
