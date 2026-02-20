'use client';

import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { budgetsApi } from '@/lib/budgets';
import { getErrorMessage } from '@/lib/errors';
import { StrategyDetailCard } from './StrategyDetailCard';
import type { WizardState } from './BudgetWizard';
import type { BudgetProfile, BudgetStrategy, GenerateBudgetResponse } from '@/types/budget';

interface BudgetWizardAnalysisProps {
  state: WizardState;
  updateState: (updates: Partial<WizardState>) => void;
  onAnalysisComplete: (result: GenerateBudgetResponse) => void;
  onNext: () => void;
  onCancel: () => void;
}

const STRATEGIES: Array<{
  value: BudgetStrategy;
  label: string;
  description: string;
}> = [
  {
    value: 'FIXED',
    label: 'Fixed',
    description: 'Set fixed amounts per category. Unused budget resets each period.',
  },
  {
    value: 'ROLLOVER',
    label: 'Rollover',
    description: 'Unused budget carries forward. Configure rollover rules per category.',
  },
  {
    value: 'ZERO_BASED',
    label: 'Zero-Based',
    description: 'Every dollar of income is assigned a purpose. Income minus expenses equals zero.',
  },
  {
    value: 'FIFTY_THIRTY_TWENTY',
    label: '50/30/20',
    description: '50% needs, 30% wants, 20% savings. Categories are tagged by group.',
  },
];

const PROFILES: Array<{
  value: BudgetProfile;
  label: string;
  description: string;
}> = [
  {
    value: 'COMFORTABLE',
    label: 'Comfortable',
    description: 'Based on your 75th percentile spending. Allows headroom.',
  },
  {
    value: 'ON_TRACK',
    label: 'On Track',
    description: 'Based on your median spending. Realistic targets.',
  },
  {
    value: 'AGGRESSIVE',
    label: 'Aggressive',
    description: 'Based on your 25th percentile. A stretch goal to save more.',
  },
];

const ANALYSIS_PERIODS = [
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
] as const;

export function BudgetWizardAnalysis({
  state,
  updateState,
  onAnalysisComplete,
  onNext,
  onCancel,
}: BudgetWizardAnalysisProps) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const strategyRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const handleStrategyClick = (value: BudgetStrategy) => {
    // Toggle on mobile: tap again to deselect
    const newStrategy = state.strategy === value ? null : value;
    updateState({ strategy: newStrategy });
  };

  const handleAnalyze = async () => {
    if (!state.strategy) return;
    setIsAnalyzing(true);
    try {
      const result = await budgetsApi.generate({
        analysisMonths: state.analysisMonths,
        strategy: state.strategy ?? undefined,
        profile: state.profile,
      });
      onAnalysisComplete(result);
      onNext();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to analyze spending'));
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Strategy selection */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Choose a Budget Strategy
        </h3>
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Strategy list - left side */}
          <div className="lg:w-[560px] lg:shrink-0 space-y-3">
            {/* Mobile: single column with detail card below selected */}
            <div className="flex flex-col gap-3 lg:hidden">
              {STRATEGIES.map((s) => {
                const isSelected = state.strategy === s.value;
                return (
                  <div key={s.value}>
                    <button
                      ref={(el) => {
                        if (el) strategyRefs.current.set(s.value, el);
                      }}
                      type="button"
                      onClick={() => handleStrategyClick(s.value)}
                      data-testid={`strategy-${s.value}-mobile`}
                      className={`w-full p-4 rounded-lg border-2 text-left transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-400'
                          : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'
                      }`}
                    >
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {s.label}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {s.description}
                      </div>
                    </button>
                    <div
                      className={`overflow-hidden transition-all duration-300 ease-in-out ${
                        isSelected ? 'max-h-[800px] opacity-100 mt-3' : 'max-h-0 opacity-0'
                      }`}
                    >
                      <StrategyDetailCard strategy={s.value} />
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Desktop: 2-column grid */}
            <div className="hidden lg:grid grid-cols-2 gap-3">
              {STRATEGIES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => updateState({ strategy: s.value })}
                  data-testid={`strategy-${s.value}`}
                  className={`w-full p-4 rounded-lg border-2 text-left transition-colors ${
                    state.strategy === s.value
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-400'
                      : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'
                  }`}
                >
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {s.label}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {s.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Detail card - right side (desktop only) */}
          {state.strategy && (
            <div className="hidden lg:block lg:flex-1 lg:min-w-0">
              <div className="sticky top-4">
                <StrategyDetailCard strategy={state.strategy} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Analysis period */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Analysis Period
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
          How many months of transaction history should we analyze to suggest
          budget amounts?
        </p>
        <div className="flex gap-3">
          {ANALYSIS_PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => updateState({ analysisMonths: p.value })}
              className={`px-4 py-2 rounded-md font-medium text-sm transition-colors ${
                state.analysisMonths === p.value
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Budget profile */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Budget Profile
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {PROFILES.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => updateState({ profile: p.value })}
              className={`p-4 rounded-lg border-2 text-left transition-colors ${
                state.profile === p.value
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-400'
                  : 'border-gray-200 hover:border-gray-300 dark:border-gray-600 dark:hover:border-gray-500'
              }`}
            >
              <div className="font-medium text-gray-900 dark:text-gray-100">
                {p.label}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {p.description}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col-reverse sm:flex-row justify-between gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleAnalyze} isLoading={isAnalyzing} disabled={!state.strategy}>
          Analyze My Spending
        </Button>
      </div>
    </div>
  );
}
