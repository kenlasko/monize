'use client';

interface BudgetProgressBarProps {
  percentUsed: number;
  pacePercent?: number;
  showPaceMarker?: boolean;
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
  const clampedPercent = Math.min(Math.max(percentUsed, 0), 100);
  const barColor = getBarColor(percentUsed);
  const pacePosition = pacePercent !== undefined
    ? Math.min(Math.max(pacePercent, 0), 100)
    : undefined;

  return (
    <div className="relative w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-300 ${barColor}`}
        style={{ width: `${clampedPercent}%` }}
        role="progressbar"
        aria-valuenow={Math.round(percentUsed)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${Math.round(percentUsed)}% used`}
      />
      {showPaceMarker && pacePosition !== undefined && (
        <div
          className="absolute top-0 h-full w-px bg-gray-500/60 dark:bg-gray-400/60"
          style={{ left: `${pacePosition}%` }}
          title={`Expected pace: ${Math.round(pacePosition)}%`}
          data-testid="pace-marker"
        />
      )}
    </div>
  );
}
