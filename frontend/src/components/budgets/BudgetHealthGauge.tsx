'use client';

import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';
import { UnknownAmount } from '@/components/ui/UnknownAmount';

interface BudgetHealthGaugeProps {
  /** `null` while spending is partial (a row had no exchange rate): the score is unknown. */
  score: number | null;
  /** The translated cause shown when the score is unknown. */
  partialReason?: string;
}

function getScoreStatus(score: number): 'excellent' | 'good' | 'needsAttention' | 'offTrack' {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'needsAttention';
  return 'offTrack';
}

function getScoreColor(score: number): {
  stroke: string;
  text: string;
  bg: string;
} {
  if (score >= 90) return {
    stroke: 'stroke-green-500 dark:stroke-green-400',
    text: 'text-green-600 dark:text-green-400',
    bg: 'bg-green-50 dark:bg-green-900/20',
  };
  if (score >= 70) return {
    stroke: 'stroke-blue-500 dark:stroke-blue-400',
    text: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
  };
  if (score >= 50) return {
    stroke: 'stroke-yellow-500 dark:stroke-yellow-400',
    text: 'text-yellow-600 dark:text-yellow-400',
    bg: 'bg-yellow-50 dark:bg-yellow-900/20',
  };
  return {
    stroke: 'stroke-red-500 dark:stroke-red-400',
    text: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-50 dark:bg-red-900/20',
  };
}

export function BudgetHealthGauge({ score, partialReason }: BudgetHealthGaugeProps) {
  const t = useTranslations('budgets');
  if (score === null) {
    return (
      <div className={`${CARD_CLASS} p-4 sm:p-6`}>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('healthGauge.title')}
        </h2>
        <div className="flex flex-col items-center gap-2 text-3xl" data-testid="score-unknown">
          <UnknownAmount reasonText={partialReason} />
          {partialReason && (
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center">{partialReason}</p>
          )}
        </div>
      </div>
    );
  }
  const clampedScore = Math.min(Math.max(Math.round(score), 0), 100);
  const status = getScoreStatus(clampedScore);
  const label = t(`healthGauge.labels.${status}`);
  const colors = getScoreColor(clampedScore);

  // SVG circle math
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clampedScore / 100) * circumference;

  return (
    <div className={`${CARD_CLASS} p-4 sm:p-6`}>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('healthGauge.title')}
      </h2>
      <div className="flex flex-col items-center">
        <div className="relative w-36 h-36">
          <svg className="ui-bud-ring w-full h-full transform -rotate-90" viewBox="0 0 128 128">
            <circle
              cx="64"
              cy="64"
              r={radius}
              fill="none"
              strokeWidth="10"
              className="ui-bud-ring-track stroke-gray-200 dark:stroke-gray-700"
            />
            <circle
              cx="64"
              cy="64"
              r={radius}
              fill="none"
              strokeWidth="10"
              strokeLinecap="round"
              className={`ui-bud-ring-arc transition-all duration-500 ${colors.stroke}`}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              data-testid="score-ring"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`ui-bud-score text-3xl font-bold ${colors.text}`} data-testid="score-value">
              {clampedScore}
            </span>
          </div>
        </div>
        <span
          className={`ui-bud-score-label mt-2 px-3 py-1 text-sm font-medium rounded-full ${colors.text} ${colors.bg}`}
          data-testid="score-label"
        >
          {label}
        </span>
      </div>
    </div>
  );
}
