'use client';

import { useState, useCallback, useEffect } from 'react';
import { BudgetWizardAnalysis } from './BudgetWizardAnalysis';
import { BudgetWizardCategories } from './BudgetWizardCategories';
import { BudgetWizardStrategy } from './BudgetWizardStrategy';
import { BudgetWizardReview } from './BudgetWizardReview';
import {
  BudgetStrategy,
  BudgetType,
  BudgetProfile,
  RolloverType,
  CategoryGroup,
  GenerateBudgetResponse,
  ApplyBudgetCategoryData,
} from '@/types/budget';

export interface WizardState {
  // Step 1: Analysis
  analysisMonths: 3 | 6 | 12;
  profile: BudgetProfile;
  strategy: BudgetStrategy;
  analysisResult: GenerateBudgetResponse | null;

  // Step 2: Categories
  selectedCategories: Map<string, ApplyBudgetCategoryData>;
  selectedTransfers: Map<string, ApplyBudgetCategoryData>;

  // Step 3: Strategy / Options
  budgetName: string;
  budgetType: BudgetType;
  periodStart: string;
  currencyCode: string;

  // Step 4: Review
  isSubmitting: boolean;
}

interface BudgetWizardProps {
  onComplete: () => void;
  onCancel: () => void;
  defaultCurrency: string;
}

const STEPS = ['Analyze', 'Categories', 'Configure', 'Review'] as const;

export function BudgetWizard({
  onComplete,
  onCancel,
  defaultCurrency,
}: BudgetWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const now = new Date();
  const defaultPeriodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const [state, setState] = useState<WizardState>({
    analysisMonths: 6,
    profile: 'ON_TRACK',
    strategy: 'FIXED',
    analysisResult: null,
    selectedCategories: new Map(),
    selectedTransfers: new Map(),
    budgetName: `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()} Budget`,
    budgetType: 'MONTHLY',
    periodStart: defaultPeriodStart,
    currencyCode: defaultCurrency,
    isSubmitting: false,
  });

  const updateState = useCallback(
    (updates: Partial<WizardState>) => {
      setState((prev) => ({ ...prev, ...updates }));
    },
    [],
  );

  // Sync wizard steps with browser history so the back button works
  useEffect(() => {
    // Replace current entry with step 0 state on mount
    window.history.replaceState({ wizardStep: 0 }, '');

    const handlePopState = (e: PopStateEvent) => {
      const step = e.state?.wizardStep;
      if (typeof step === 'number') {
        setCurrentStep(step);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const goNext = useCallback(() => {
    setCurrentStep((prev) => {
      const next = Math.min(prev + 1, STEPS.length - 1);
      window.history.pushState({ wizardStep: next }, '');
      return next;
    });
  }, []);

  const goBack = useCallback(() => {
    setCurrentStep((prev) => {
      if (prev <= 0) return 0;
      window.history.back();
      return Math.max(prev - 1, 0);
    });
  }, []);

  const initCategoriesFromAnalysis = useCallback(
    (result: GenerateBudgetResponse) => {
      const is503020 = state.strategy === 'FIFTY_THIRTY_TWENTY';
      const categories = new Map<string, ApplyBudgetCategoryData>();
      for (const cat of result.categories) {
        // Skip expense categories with zero suggested amount (sporadic spending)
        if (cat.suggested <= 0 && !cat.isIncome) continue;
        categories.set(cat.categoryId, {
          categoryId: cat.categoryId,
          amount: cat.suggested,
          isIncome: cat.isIncome,
          rolloverType: 'NONE' as RolloverType,
          ...(is503020 && !cat.isIncome ? { categoryGroup: 'NEED' as CategoryGroup } : {}),
        });
      }

      const transfers = new Map<string, ApplyBudgetCategoryData>();
      for (const t of result.transfers ?? []) {
        if (t.suggested <= 0) continue;
        transfers.set(t.accountId, {
          transferAccountId: t.accountId,
          isTransfer: true,
          amount: t.suggested,
          rolloverType: 'NONE' as RolloverType,
          ...(is503020 ? { categoryGroup: 'SAVING' as CategoryGroup } : {}),
        });
      }

      updateState({
        analysisResult: result,
        selectedCategories: categories,
        selectedTransfers: transfers,
      });
    },
    [updateState, state.strategy],
  );

  return (
    <div>
      {/* Step indicators */}
      <nav aria-label="Wizard steps" className="mb-8">
        <ol className="flex items-center justify-center gap-1 sm:gap-2">
          {STEPS.map((stepName, index) => (
            <li key={stepName} className="flex items-center">
              <div
                className={`flex items-center gap-1 sm:gap-2 px-2 py-1 sm:px-3 sm:py-1.5 rounded-full text-xs sm:text-sm font-medium ${
                  index === currentStep
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                    : index < currentStep
                      ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200'
                      : 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400'
                }`}
              >
                <span
                  className={`flex items-center justify-center w-5 h-5 text-[10px] sm:w-6 sm:h-6 sm:text-xs rounded-full font-bold ${
                    index === currentStep
                      ? 'bg-blue-600 text-white'
                      : index < currentStep
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-300 text-gray-600 dark:bg-gray-600 dark:text-gray-300'
                  }`}
                >
                  {index < currentStep ? '\u2713' : index + 1}
                </span>
                <span className="hidden sm:inline">{stepName}</span>
              </div>
              {index < STEPS.length - 1 && (
                <div
                  className={`w-4 sm:w-8 h-0.5 mx-0.5 sm:mx-1 ${
                    index < currentStep
                      ? 'bg-green-400 dark:bg-green-600'
                      : 'bg-gray-200 dark:bg-gray-600'
                  }`}
                />
              )}
            </li>
          ))}
        </ol>
      </nav>

      {/* Step content */}
      {currentStep === 0 && (
        <BudgetWizardAnalysis
          state={state}
          updateState={updateState}
          onAnalysisComplete={initCategoriesFromAnalysis}
          onNext={goNext}
          onCancel={onCancel}
        />
      )}
      {currentStep === 1 && (
        <BudgetWizardCategories
          state={state}
          updateState={updateState}
          onNext={goNext}
          onBack={goBack}
        />
      )}
      {currentStep === 2 && (
        <BudgetWizardStrategy
          state={state}
          updateState={updateState}
          onNext={goNext}
          onBack={goBack}
        />
      )}
      {currentStep === 3 && (
        <BudgetWizardReview
          state={state}
          updateState={updateState}
          onComplete={onComplete}
          onBack={goBack}
        />
      )}
    </div>
  );
}
