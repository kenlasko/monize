'use client';

import { useState } from 'react';
import type { AiUsageSummary } from '@/types/ai';

interface UsageDashboardProps {
  usage: AiUsageSummary;
  onPeriodChange: (days?: number) => void;
}

const PERIOD_OPTIONS = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: 'All time', value: undefined },
];

export function UsageDashboard({ usage, onPeriodChange }: UsageDashboardProps) {
  const [selectedPeriod, setSelectedPeriod] = useState<number | undefined>(30);

  const handlePeriodChange = (days: number | undefined) => {
    setSelectedPeriod(days);
    onPeriodChange(days);
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Usage</h2>
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => handlePeriodChange(opt.value)}
              className={`px-3 py-1 text-xs rounded-md ${
                selectedPeriod === opt.value
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                  : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">Total Requests</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {usage.totalRequests.toLocaleString()}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">Input Tokens</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {usage.totalInputTokens.toLocaleString()}
          </p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <p className="text-xs text-gray-500 dark:text-gray-400">Output Tokens</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {usage.totalOutputTokens.toLocaleString()}
          </p>
        </div>
      </div>

      {/* By Provider */}
      {usage.byProvider.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">By Provider</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 font-medium">Provider</th>
                  <th className="pb-2 font-medium text-right">Requests</th>
                  <th className="pb-2 font-medium text-right">Input Tokens</th>
                  <th className="pb-2 font-medium text-right">Output Tokens</th>
                </tr>
              </thead>
              <tbody>
                {usage.byProvider.map((row) => (
                  <tr key={row.provider} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 text-gray-900 dark:text-white">{row.provider}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.requests.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.inputTokens.toLocaleString()}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">{row.outputTokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Logs */}
      {usage.recentLogs.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Recent Activity</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Provider</th>
                  <th className="pb-2 font-medium">Feature</th>
                  <th className="pb-2 font-medium text-right">Tokens</th>
                  <th className="pb-2 font-medium text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {usage.recentLogs.map((log) => (
                  <tr key={log.id} className="border-b border-gray-100 dark:border-gray-700/50">
                    <td className="py-2 text-gray-600 dark:text-gray-300">
                      {new Date(log.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2 text-gray-900 dark:text-white">{log.provider}</td>
                    <td className="py-2 text-gray-600 dark:text-gray-300">{log.feature}</td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">
                      {(log.inputTokens + log.outputTokens).toLocaleString()}
                    </td>
                    <td className="py-2 text-right text-gray-600 dark:text-gray-300">
                      {log.durationMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {usage.totalRequests === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No usage data yet. Usage will appear here once you start using AI features.
        </p>
      )}
    </div>
  );
}
