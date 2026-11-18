"use client";

import { useContext } from "react";
import { useTranslations } from "next-intl";
import {
  CalendarDaysIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/Button";
import { BackToReportsLink } from "@/components/reports/BackToReportsLink";
import { useReportSwitcher } from "@/components/reports/ReportSwitcher";
import { EntitySwitcher } from "@/components/ui/EntitySwitcher";
import {
  CollapsingTitleContext,
  useCollapsingHeaderTitle,
} from "@/hooks/useCollapsingHeaderTitle";
import { InfoTooltip } from "@/components/ui/InfoTooltip";
import { TOUR_ANCHORS, tourAnchor } from "@/lib/tours/anchors";
import { useDateFormat } from "@/hooks/useDateFormat";
import { GemCadence, GemStrategyRef } from "@/types/gem-strategy";
import { isKnown } from "@/lib/gem-strategy-view";
import { useGemLabels } from "./useGemLabels";
import {
  GemScenarioSwitcher,
  type GemScenarioOutcome,
} from "./GemScenarioSwitcher";

interface GemStrategyHeaderProps {
  /**
   * The scenario on screen, and every saved one, for the switcher. The id is
   * null until the first save, when there is a report but no stored strategy.
   */
  strategyId: string | null;
  strategyName: string;
  scenarios: readonly GemStrategyRef[];
  onSelectScenario: (id: string) => void;
  /**
   * Whether each happened, failed, or is waiting on the user: the switcher's
   * dialogs survive a failure and step aside for a deferral.
   */
  onCreateScenario: (name: string) => Promise<GemScenarioOutcome>;
  onDeleteScenario: (id: string) => Promise<GemScenarioOutcome>;
  scenarioBusy: boolean;
  cadence: GemCadence;
  /** The strategy's momentum window, which the explainer names. */
  lookbackMonths: number;
  nextEvaluationOn: string | null;
  daysUntilNextEvaluation: number | null;
  onEditSettings: () => void;
}

/**
 * Page header: the way back to Reports, the title with the strategy explainer,
 * and the evaluation cadence block. The cadence/next-evaluation pair lives here so the
 * summary cards below do not repeat it.
 */
export function GemStrategyHeader({
  strategyId,
  strategyName,
  scenarios,
  onSelectScenario,
  onCreateScenario,
  onDeleteScenario,
  scenarioBusy,
  cadence,
  lookbackMonths,
  nextEvaluationOn,
  daysUntilNextEvaluation,
  onEditSettings,
}: GemStrategyHeaderProps) {
  const t = useTranslations("strategies");
  const tr = useTranslations("reports");
  const { cadenceLabel } = useGemLabels();
  const reportSwitcher = useReportSwitcher("gem-strategy");
  // Below `xl`, once the title scrolls behind the app header, the header reads
  // "Reports - <this scenario>" and carries the report caret.
  const collapses = useContext(CollapsingTitleContext);
  const titleRef = useCollapsingHeaderTitle<HTMLHeadingElement>(
    collapses
      ? { title: tr("page.title"), context: strategyName, switcher: reportSwitcher }
      : null,
  );
  const { formatDate } = useDateFormat();

  return (
    <header className="mb-4" {...tourAnchor(TOUR_ANCHORS.gemStrategyHeader)}>
      {/* The same way back the other report pages carry. The title below is the
          scenario's name, so the caret beside it switches scenarios rather than
          reports -- one level in from the report switcher, the way the account
          detail page's caret switches accounts. */}
      <BackToReportsLink />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-1">
            <h1 ref={titleRef} className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {strategyName}
            </h1>
            {/* The report caret, in the slot every other report page puts it:
                straight after the title. The scenario controls that follow name
                themselves, because two bare chevrons a few pixels apart say
                nothing about which switches what. */}
            <EntitySwitcher {...reportSwitcher} />
            <InfoTooltip
              // The window is configurable, so the explainer names the one
              // this strategy actually runs rather than the canonical twelve.
              text={t("gem.header.explainer", { months: lookbackMonths })}
              usePortal
            />
            <GemScenarioSwitcher
              currentId={strategyId}
              currentName={strategyName}
              scenarios={scenarios}
              onSelect={onSelectScenario}
              onCreate={onCreateScenario}
              onDelete={onDeleteScenario}
              busy={scenarioBusy}
            />
          </div>
          <p className="text-gray-500 dark:text-gray-400">
            {t("gem.header.subtitle")}
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
          <div className="flex items-start gap-2 text-sm">
            <CalendarDaysIcon
              className="mt-0.5 h-4 w-4 shrink-0 text-gray-400 dark:text-gray-500"
              aria-hidden="true"
            />
            <div>
              <p className="text-gray-600 dark:text-gray-300">
                {t("gem.header.cadence", { cadence: cadenceLabel(cadence) })}
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                {nextEvaluationOn
                  ? isKnown(daysUntilNextEvaluation)
                    ? t("gem.header.nextEvaluationWithDays", {
                        date: formatDate(nextEvaluationOn),
                        days: daysUntilNextEvaluation,
                      })
                    : t("gem.header.nextEvaluation", {
                        date: formatDate(nextEvaluationOn),
                      })
                  : t("gem.header.nextEvaluationUnknown")}
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            onClick={onEditSettings}
            className="shrink-0 gap-2"
            {...tourAnchor(TOUR_ANCHORS.gemStrategyEditSettings)}
          >
            <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
            {t("gem.header.editSettings")}
          </Button>
        </div>
      </div>
    </header>
  );
}
