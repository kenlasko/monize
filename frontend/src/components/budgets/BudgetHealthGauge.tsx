'use client';

interface BudgetHealthGaugeProps {
  score: number;
}

function getScoreLabel(score: number): string {
  if (score >= 90) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 50) return 'Needs Attention';
  return 'Off Track';
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

export function BudgetHealthGauge({ score }: BudgetHealthGaugeProps) {
  const clampedScore = Math.min(Math.max(Math.round(score), 0), 100);
  const label = getScoreLabel(clampedScore);
  const colors = getScoreColor(clampedScore);

  // SVG circle math
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clampedScore / 100) * circumference;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Health Score
      </h2>
      <div className="flex flex-col items-center">
        <div className="relative w-36 h-36">
          <svg className="w-full h-full transform -rotate-90" viewBox="0 0 128 128">
            <circle
              cx="64"
              cy="64"
              r={radius}
              fill="none"
              strokeWidth="10"
              className="stroke-gray-200 dark:stroke-gray-700"
            />
            <circle
              cx="64"
              cy="64"
              r={radius}
              fill="none"
              strokeWidth="10"
              strokeLinecap="round"
              className={`transition-all duration-500 ${colors.stroke}`}
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              data-testid="score-ring"
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-3xl font-bold ${colors.text}`} data-testid="score-value">
              {clampedScore}
            </span>
          </div>
        </div>
        <span
          className={`mt-2 px-3 py-1 text-sm font-medium rounded-full ${colors.text} ${colors.bg}`}
          data-testid="score-label"
        >
          {label}
        </span>
      </div>
    </div>
  );
}
