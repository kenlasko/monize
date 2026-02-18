'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { aiApi } from '@/lib/ai';
import { AiInsight } from '@/types/ai';

const severityColors: Record<string, string> = {
  alert: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
  warning: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
  info: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
};

interface InsightsWidgetProps {
  isLoading: boolean;
}

export function InsightsWidget({ isLoading: parentLoading }: InsightsWidgetProps) {
  const router = useRouter();
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (parentLoading) return;

    const loadInsights = async () => {
      try {
        const response = await aiApi.getInsights();
        setInsights(response.insights.slice(0, 3));
      } catch {
        // Silently fail - widget is optional
      } finally {
        setIsLoading(false);
      }
    };

    loadInsights();
  }, [parentLoading]);

  const sectionTitle = 'Spending Insights';

  if (isLoading || parentLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <button
          onClick={() => router.push('/insights')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {sectionTitle}
        </button>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (insights.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <button
          onClick={() => router.push('/insights')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          {sectionTitle}
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No insights available. Visit the Insights page to generate your first analysis.
        </p>
        <button
          onClick={() => router.push('/insights')}
          className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
        >
          Go to Insights
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push('/insights')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {sectionTitle}
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {insights.length} active
        </span>
      </div>
      <div className="space-y-2 sm:space-y-3">
        {insights.map((insight) => {
          const colors = severityColors[insight.severity] || severityColors.info;
          return (
            <div
              key={insight.id}
              className={`p-2 sm:p-3 rounded-lg border ${colors}`}
            >
              <div className="font-medium text-sm">{insight.title}</div>
              <div className="text-xs mt-0.5 opacity-80 line-clamp-2">
                {insight.description}
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => router.push('/insights')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        View all insights
      </button>
    </div>
  );
}
