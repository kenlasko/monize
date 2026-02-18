'use client';

import { AiInsight, INSIGHT_TYPE_LABELS } from '@/types/ai';

interface InsightCardProps {
  insight: AiInsight;
  onDismiss: (id: string) => void;
  isDismissing: boolean;
}

const severityStyles: Record<string, { border: string; bg: string; icon: string; iconColor: string }> = {
  alert: {
    border: 'border-red-200 dark:border-red-800',
    bg: 'bg-red-50 dark:bg-red-900/20',
    icon: '!',
    iconColor: 'text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40',
  },
  warning: {
    border: 'border-amber-200 dark:border-amber-800',
    bg: 'bg-amber-50 dark:bg-amber-900/20',
    icon: '!',
    iconColor: 'text-amber-600 dark:text-amber-400 bg-amber-100 dark:bg-amber-900/40',
  },
  info: {
    border: 'border-blue-200 dark:border-blue-800',
    bg: 'bg-blue-50 dark:bg-blue-900/20',
    icon: 'i',
    iconColor: 'text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40',
  },
};

const typeStyles: Record<string, string> = {
  anomaly: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  trend: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  subscription: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
  budget_pace: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  seasonal: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  new_recurring: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

export function InsightCard({ insight, onDismiss, isDismissing }: InsightCardProps) {
  const style = severityStyles[insight.severity] || severityStyles.info;
  const typeStyle = typeStyles[insight.type] || typeStyles.anomaly;

  return (
    <div
      className={`rounded-lg border ${style.border} ${style.bg} p-4 transition-opacity ${
        insight.isDismissed ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm ${style.iconColor}`}
        >
          {style.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
              {insight.title}
            </h3>
            <span
              className={`px-1.5 py-0.5 text-xs font-medium rounded ${typeStyle}`}
            >
              {INSIGHT_TYPE_LABELS[insight.type]}
            </span>
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
            {insight.description}
          </p>
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(insight.generatedAt).toLocaleDateString()}
            </span>
            {!insight.isDismissed && (
              <button
                onClick={() => onDismiss(insight.id)}
                disabled={isDismissing}
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-50"
              >
                {isDismissing ? 'Dismissing...' : 'Dismiss'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
