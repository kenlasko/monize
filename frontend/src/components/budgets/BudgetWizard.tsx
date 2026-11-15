'use client';

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
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
import type { Account } from '@/types/account';
import { newClientId } from '@/lib/client-id';
import {
  findBudgetBucketPreset,
  materializeBudgetBucketPreset,
  type BudgetBucketEditorRow,
} from './utils/budget-bucket-presets';

export interface WizardState {
  // Step 1: Analysis
  analysisMonths: 3 | 6 | 12;
  profile: BudgetProfile;
  strategy: BudgetStrategy | null;
  analysisResult: GenerateBudgetResponse | null;

  // Step 2: Categories
  selectedCategories: Map<string, ApplyBudgetCategoryData>;
  selectedTransfers: Map<string, ApplyBudgetCategoryData>;
  /** Transfer income lines, keyed by source account (issue #2141). */
  selectedIncomeTransfers: Map<string, ApplyBudgetCategoryData>;
  /**
   * The Bucket strategy's buckets, edited in memory; each row's `key` is the
   * apply request's bucket key and a line's `bucketKey`. Kept when the strategy
   * changes, and only sent while the strategy is Bucket.
   */
  buckets: BudgetBucketEditorRow[];
  /**
   * Set once the Bucket strategy has pre-applied its preset. A list the person
   * then empties ("Start from scratch") stays empty on a later analysis.
   */
  bucketsPresetApplied: boolean;

  // Step 3: Strategy / Options
  budgetName: string;
  budgetType: BudgetType;
  periodStart: string;
  currencyCode: string;
  baseIncome: number | null;
  incomeLinked: boolean;
  defaultRolloverType: RolloverType;
  alertWarnPercent: number;
  alertCriticalPercent: number;
  excludedAccountIds: string[];
  /** Transfers in from the excluded accounts count as income. */
  transfersInAsIncome: boolean;

  // Step 4: Review
  isSubmitting: boolean;
}

interface BudgetWizardProps {
  onComplete: () => void;
  onCancel: () => void;
  defaultCurrency: string;
  accounts?: Account[];
}

const STEPS = ['analyze', 'categories', 'configure', 'review'] as const;

export function BudgetWizard({
  onComplete,
  onCancel,
  defaultCurrency,
  accounts = [],
}: BudgetWizardProps) {
  const t = useTranslations('budgets');
  const [currentStep, setCurrentStep] = useState(0);
  const now = new Date();
  const defaultPeriodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const [state, setState] = useState<WizardState>({
    analysisMonths: 6,
    profile: 'ON_TRACK',
    strategy: typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
      ? 'FIXED'
      : null,
    analysisResult: null,
    selectedCategories: new Map(),
    selectedTransfers: new Map(),
    selectedIncomeTransfers: new Map(),
    buckets: [],
    bucketsPresetApplied: false,
    budgetName: `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()} Budget`,
    budgetType: 'MONTHLY',
    periodStart: defaultPeriodStart,
    currencyCode: defaultCurrency,
    baseIncome: null,
    incomeLinked: false,
    defaultRolloverType: 'NONE',
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    excludedAccountIds: [],
    transfersInAsIncome: false,
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
    // Push a new entry so the Budgets page stays in history behind us
    window.history.pushState({ wizardStep: 0 }, '');

    const handlePopState = (e: PopStateEvent) => {
      const step = e.state?.wizardStep;
      if (typeof step === 'number') {
        setCurrentStep(step);
      } else {
        // Navigated back past the wizard — return to the Budgets page
        onCancel();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [onCancel]);

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
      const isBucket = state.strategy === 'BUCKET';
      const isRollover = state.strategy === 'ROLLOVER';
      const defaultRollover: RolloverType = isRollover ? 'MONTHLY' : 'NONE';
      const categories = new Map<string, ApplyBudgetCategoryData>();
      for (const cat of result.categories) {
        // Skip expense categories with zero suggested amount (sporadic spending)
        if (cat.suggested <= 0 && !cat.isIncome) continue;
        categories.set(cat.categoryId, {
          categoryId: cat.categoryId,
          amount: cat.suggested,
          isIncome: cat.isIncome,
          rolloverType: defaultRollover,
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
          rolloverType: defaultRollover,
          ...(is503020 ? { categoryGroup: 'SAVING' as CategoryGroup } : {}),
        });
      }

      // Bucket: pre-apply "Three buckets" once (names translated once, no line
      // assigned). A list the person already has is never replaced, and one
      // they emptied afterwards stays empty.
      const applyPreset =
        isBucket && !state.bucketsPresetApplied && state.buckets.length === 0;
      const buckets = applyPreset
        ? materializeBudgetBucketPreset(findBudgetBucketPreset('THREE'), t, newClientId)
        : state.buckets;
      if (isBucket) {
        // A re-run keeps each surviving line's bucket while that bucket exists.
        const keys = new Set(buckets.map((b) => b.key));
        const carry = (
          next: Map<string, ApplyBudgetCategoryData>,
          prev: Map<string, ApplyBudgetCategoryData>,
        ) => {
          for (const [id, entry] of next) {
            const key = prev.get(id)?.bucketKey;
            if (key !== undefined && keys.has(key) && !entry.isIncome) {
              next.set(id, { ...entry, bucketKey: key });
            }
          }
        };
        carry(categories, state.selectedCategories);
        carry(transfers, state.selectedTransfers);
      }

      // Set base income from analysis if available
      const estimatedIncome = result.estimatedMonthlyIncome > 0
        ? Math.round(result.estimatedMonthlyIncome * 100) / 100
        : null;

      updateState({
        analysisResult: result,
        selectedCategories: categories,
        selectedTransfers: transfers,
        // None preselected: only the user knows which source is a reserve.
        selectedIncomeTransfers: new Map(),
        baseIncome: estimatedIncome,
        defaultRolloverType: defaultRollover,
        ...(isBucket ? { buckets, bucketsPresetApplied: true } : {}),
      });
    },
    [updateState, state.strategy, state.buckets, state.bucketsPresetApplied, state.selectedCategories, state.selectedTransfers, t],
  );

  return (
    <div>
      {/* Step indicators */}
      <nav aria-label={t('wizard.ariaLabel')} className="mb-8">
        <ol className="flex items-center justify-center gap-1 sm:gap-2">
          {STEPS.map((stepKey, index) => (
            <li key={stepKey} className="flex items-center">
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
                <span className="hidden sm:inline">{t(`wizard.steps.${stepKey}`)}</span>
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
          accounts={accounts}
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
