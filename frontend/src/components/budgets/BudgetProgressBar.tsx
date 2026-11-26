'use client';

import { useTranslations } from 'next-intl';
import { clamp } from '@/lib/clamp';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface BudgetProgressBarProps {
  percentUsed: number;
  pacePercent?: number;
  showPaceMarker?: boolean;
}

/**
 * How far through its budget the bar is, as the `data-level` a UI style reads
 * (`ui-styles-kit.css`): Folio draws the bar in ink and only an overspend in
 * the loss colour, so it needs the level, not the colour class.
 */
function getLevel(percent: number): 'over' | 'high' | 'warn' | 'ok' {
  if (percent >= 100) return 'over';
  if (percent >= 90) return 'high';
  if (percent >= 75) return 'warn';
  return 'ok';
}

function getBarColor(percent: number): string {
  if (percent >= 100) return 'bg-red-500 dark:bg-red-400';
  if (percent >= 90) return 'bg-orange-500 dark:bg-orange-400';
  if (percent >= 75) return 'bg-yellow-500 dark:bg-yellow-400';
  return 'bg-green-500 dark:bg-green-400';
}

export function BudgetProgressBar({
  percentUsed,
  pacePercent,
  showPaceMarker = false,
}: BudgetProgressBarProps) {
  const t = useTranslations('budgets');
  const { formatPercentTrimmed } = useNumberFormat();
  const clampedPercent = clamp(percentUsed, 0, 100);
  const outsideBar = percentUsed !== clampedPercent;
  const formattedPercent = formatPercentTrimmed(outsideBar ? percentUsed : Math.round(percentUsed));
  const barColor = getBarColor(percentUsed);
  const pacePosition = pacePercent !== undefined
    ? clamp(pacePercent, 0, 100)
    : undefined;

  return (
    <div className="ui-meter relative w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
      <div
        className={`ui-meter-fill h-full rounded-full transition-all duration-300 ${barColor}`}
        data-level={getLevel(percentUsed)}
        style={{ width: `${clampedPercent}%` }}
        role="progressbar"
        aria-valuenow={Math.round(clampedPercent)}
        aria-valuetext={outsideBar ? formattedPercent : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('progressBar.ariaLabel', { percent: formattedPercent })}
      />
      {showPaceMarker && pacePosition !== undefined && (
        <div
          className="ui-meter-pace absolute top-0 h-full w-px bg-gray-500/60 dark:bg-gray-400/60"
          style={{ left: `${pacePosition}%` }}
          title={t('progressBar.paceMarkerTitle', { percent: formatPercentTrimmed(Math.round(pacePosition)) })}
          data-testid="pace-marker"
        />
      )}
    </div>
  );
}
