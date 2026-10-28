"use client";

import {
  ReportingBasisScope,
  ReportingBasisControl,
  useReportingBasis,
} from "@/components/reports/ReportingBasis";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import toast from "react-hot-toast";
import { useOnUndoRedo } from "@/hooks/useOnUndoRedo";
import { useOnAiAction } from "@/hooks/useOnAiAction";
import { Button } from "@/components/ui/Button";
import { PageLayout } from "@/components/layout/PageLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { BudgetWizard } from "@/components/budgets/BudgetWizard";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { budgetsApi } from "@/lib/budgets";
import { accountsApi } from "@/lib/accounts";
import { useExchangeRates } from "@/hooks/useExchangeRates";
import { getErrorMessage } from "@/lib/errors";
import {
  STRATEGY_LABELS,
  BUDGET_TYPE_LABELS,
} from "@/components/budgets/utils/budget-labels";
import type { Budget } from "@/types/budget";
import type { Account } from "@/types/account";

export default function BudgetsPage() {
  return (
    <ProtectedRoute>
      <ReportingBasisScope surface="budgets" resetOnBasis>
        <BudgetsContent />
      </ReportingBasisScope>
    </ProtectedRoute>
  );
}

function BudgetsContent() {
  const basis = useReportingBasis();
  const t = useTranslations("budgets");
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const { defaultCurrency } = useExchangeRates();
  const router = useRouter();

  // The mount load: the state already says loading.
  const fetchBudgets = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const data = await budgetsApi.getAll(
          ...(basis ? ([basis] as const) : []),
        );
        setBudgets(data);
      } catch (error) {
        // A 403 here means a delegate hit /budgets without the section
        // grant; DelegateSectionGuard already shows the single, consistent
        // "no access" message and redirects, so don't double-toast.
        const status =
          typeof error === "object" && error && "response" in error
            ? (error as { response?: { status?: number } }).response?.status
            : undefined;
        if (status !== 403) {
          toast.error(
            getErrorMessage(error, t("pages.detail.toasts.loadFailed")),
          );
        }
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t, basis]);

  const loadBudgets = useCallback(() => {
    setIsLoading(true);
    return fetchBudgets();
  }, [fetchBudgets]);

  useEffect(() => {
    fetchBudgets();
    accountsApi
      .getAll()
      .then(setAccounts)
      .catch(() => {});
  }, [fetchBudgets]);

  useOnUndoRedo(loadBudgets);
  // Refresh on AI chat-bubble writes (budget spending can change).
  useOnAiAction(loadBudgets);

  const handleWizardComplete = () => {
    setShowWizard(false);
    loadBudgets();
  };

  if (showWizard) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <ReportingBasisControl />
          <PageHeader
            title={t("pages.create.title")}
            subtitle={t("pages.create.subtitle")}
          />
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <BudgetWizard
              onComplete={handleWizardComplete}
              onCancel={() => setShowWizard(false)}
              defaultCurrency={defaultCurrency}
              accounts={accounts}
            />
          </div>
        </main>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <ReportingBasisControl />
        <PageHeader
          title={t("pages.list.title")}
          subtitle={t("pages.list.subtitle")}
          helpUrl="https://github.com/kenlasko/monize/wiki/Budgets"
          actions={
            <Button onClick={() => setShowWizard(true)}>
              {t("pages.list.newBudget")}
            </Button>
          }
        />

        {isLoading ? (
          <LoadingSpinner />
        ) : budgets.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-12 text-center">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              {t("pages.list.empty.title")}
            </h3>
            <p className="text-gray-500 dark:text-gray-400 mb-6">
              {t("pages.list.empty.description")}
            </p>
            <Button onClick={() => setShowWizard(true)}>
              {t("pages.list.empty.cta")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {budgets.map((budget) => (
              <div
                key={budget.id}
                className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 hover:shadow-md transition-shadow cursor-pointer"
                onClick={() => router.push(`/budgets/${budget.id}`)}
                role="link"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {budget.name}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {STRATEGY_LABELS[budget.strategy] ?? budget.strategy} -{" "}
                      {BUDGET_TYPE_LABELS[budget.budgetType] ??
                        budget.budgetType}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium ${
                      budget.isActive
                        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                        : "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                    }`}
                  >
                    {budget.isActive
                      ? t("pages.list.card.active")
                      : t("pages.list.card.inactive")}
                  </span>
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                  <div>
                    {t("pages.list.card.categories", {
                      count: budget.categories?.length ?? 0,
                    })}
                  </div>
                  <div>
                    {t("pages.list.card.started", { date: budget.periodStart })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
