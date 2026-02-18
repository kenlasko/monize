'use client';

import { useState, useEffect, useCallback } from 'react';
import { aiApi } from '@/lib/ai';
import { AiInsight, InsightType, InsightSeverity, INSIGHT_TYPE_LABELS, INSIGHT_SEVERITY_LABELS } from '@/types/ai';
import { InsightCard } from './InsightCard';
import { createLogger } from '@/lib/logger';

const logger = createLogger('InsightsList');

export function InsightsList() {
  const [insights, setInsights] = useState<AiInsight[]>([]);
  const [total, setTotal] = useState(0);
  const [lastGeneratedAt, setLastGeneratedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<InsightType | ''>('');
  const [filterSeverity, setFilterSeverity] = useState<InsightSeverity | ''>('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadInsights = useCallback(async () => {
    try {
      setError(null);
      const response = await aiApi.getInsights({
        type: filterType || undefined,
        severity: filterSeverity || undefined,
        includeDismissed: showDismissed,
      });
      setInsights(response.insights);
      setTotal(response.total);
      setLastGeneratedAt(response.lastGeneratedAt);
    } catch (err) {
      logger.error('Failed to load insights:', err);
      setError('Failed to load insights. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [filterType, filterSeverity, showDismissed]);

  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError(null);
    try {
      const response = await aiApi.generateInsights();
      setInsights(response.insights);
      setTotal(response.total);
      setLastGeneratedAt(response.lastGeneratedAt);
    } catch (err) {
      logger.error('Failed to generate insights:', err);
      setError('Failed to generate insights. Make sure you have an AI provider configured.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDismiss = async (id: string) => {
    setDismissingId(id);
    try {
      await aiApi.dismissInsight(id);
      setInsights((prev) =>
        showDismissed
          ? prev.map((i) => (i.id === id ? { ...i, isDismissed: true } : i))
          : prev.filter((i) => i.id !== id),
      );
      setTotal((prev) => (showDismissed ? prev : prev - 1));
    } catch (err) {
      logger.error('Failed to dismiss insight:', err);
    } finally {
      setDismissingId(null);
    }
  };

  const alertCount = insights.filter((i) => i.severity === 'alert' && !i.isDismissed).length;
  const warningCount = insights.filter((i) => i.severity === 'warning' && !i.isDismissed).length;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 bg-gray-200 dark:bg-gray-700 rounded-lg"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with stats and actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {alertCount > 0 && (
            <span className="px-2 py-1 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded-full">
              {alertCount} alert{alertCount !== 1 ? 's' : ''}
            </span>
          )}
          {warningCount > 0 && (
            <span className="px-2 py-1 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded-full">
              {warningCount} warning{warningCount !== 1 ? 's' : ''}
            </span>
          )}
          {lastGeneratedAt && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Last updated: {new Date(lastGeneratedAt).toLocaleString()}
            </span>
          )}
        </div>
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isGenerating ? 'Generating...' : 'Refresh Insights'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={filterType}
          onChange={(e) => setFilterType(e.target.value as InsightType | '')}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option value="">All Types</option>
          {Object.entries(INSIGHT_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value as InsightSeverity | '')}
          className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        >
          <option value="">All Severities</option>
          {Object.entries(INSIGHT_SEVERITY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(e) => setShowDismissed(e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-600"
          />
          Show dismissed
        </label>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Insights list */}
      {insights.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            {total === 0
              ? 'No insights generated yet. Click "Refresh Insights" to analyze your spending patterns.'
              : 'No insights match your current filters.'}
          </p>
          {total === 0 && (
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {isGenerating ? 'Generating...' : 'Generate Insights'}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              onDismiss={handleDismiss}
              isDismissing={dismissingId === insight.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
