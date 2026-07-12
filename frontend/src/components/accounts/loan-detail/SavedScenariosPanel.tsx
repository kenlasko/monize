'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { OverpaymentPlan, ScenarioComparison } from '@/lib/loan-schedule';
import { loanScenariosApi, planToScenarioData, scenarioToPlan } from '@/lib/loan-scenarios';
import { LoanScenario } from '@/types/loan-scenario';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';

interface SavedScenariosPanelProps {
  accountId: string;
  scenarios: LoanScenario[];
  /** Each scenario's outcome vs the baseline, keyed by scenario id, so the
   *  list shows a comparison table. Null for a scenario that can't project. */
  comparisons: Map<string, ScenarioComparison | null>;
  currencyCode: string;
  /** The simulator's current plan; enables saving when non-null */
  activePlan: OverpaymentPlan | null;
  onLoad: (plan: OverpaymentPlan | null, scenario: LoanScenario) => void;
  onScenariosChanged: () => void;
}

/**
 * Saved what-if scenarios for a loan: save the simulator's current inputs
 * under a name, load one back into the simulator, rename, or delete.
 */
export function SavedScenariosPanel({
  accountId,
  scenarios,
  comparisons,
  currencyCode,
  activePlan,
  onLoad,
  onScenariosChanged,
}: SavedScenariosPanelProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();

  const [nameModal, setNameModal] = useState<
    | { mode: 'save' }
    | { mode: 'rename'; scenario: LoanScenario }
    | null
  >(null);
  const [nameInput, setNameInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scenarioToDelete, setScenarioToDelete] = useState<LoanScenario | null>(null);

  const openSave = () => {
    setNameInput('');
    setNameModal({ mode: 'save' });
  };

  const openRename = (scenario: LoanScenario) => {
    setNameInput(scenario.name);
    setNameModal({ mode: 'rename', scenario });
  };

  const submitName = async () => {
    const name = nameInput.trim();
    if (!name || !nameModal) return;
    setIsSubmitting(true);
    try {
      if (nameModal.mode === 'save') {
        await loanScenariosApi.create(accountId, planToScenarioData(activePlan, name));
        toast.success(t('loanDetail.scenarios.savedToast', { name }));
      } else {
        await loanScenariosApi.update(accountId, nameModal.scenario.id, { name });
        toast.success(t('loanDetail.scenarios.renamedToast', { name }));
      }
      setNameModal(null);
      onScenariosChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.scenarios.saveFailed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!scenarioToDelete) return;
    try {
      await loanScenariosApi.delete(accountId, scenarioToDelete.id);
      toast.success(t('loanDetail.scenarios.deletedToast', { name: scenarioToDelete.name }));
      onScenariosChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, t('loanDetail.scenarios.deleteFailed')));
    } finally {
      setScenarioToDelete(null);
    }
  };

  const describeScenario = (scenario: LoanScenario): string => {
    const parts: string[] = [];
    if (scenario.recurringExtraAmount && scenario.recurringExtraAmount > 0) {
      parts.push(
        t('loanDetail.scenarios.recurringSummary', {
          amount: formatCurrency(scenario.recurringExtraAmount),
        }),
      );
    }
    if (scenario.lumpSums.length > 0) {
      parts.push(
        t('loanDetail.scenarios.lumpSumSummary', { count: scenario.lumpSums.length }),
      );
    }
    return parts.join(' + ') || t('loanDetail.scenarios.emptyScenario');
  };

  const payoffLabel = (comparison: ScenarioComparison | null) =>
    comparison
      ? comparison.scenario.payoffDate
        ? formatChartDate(comparison.scenario.payoffDate, 'MMM yyyy')
        : t('loanDetail.comparison.beyondProjection')
      : '—';

  const timeSavedLabel = (comparison: ScenarioComparison | null) => {
    if (!comparison) return '—';
    if (comparison.installmentReduction > 0.005) {
      return t('loanDetail.comparison.installmentDrop', {
        payment: formatCurrency(comparison.scenario.finalPaymentAmount, currencyCode),
        reduction: formatCurrency(comparison.installmentReduction, currencyCode),
      });
    }
    return comparison.monthsSaved > 0
      ? t('loanDetail.comparison.monthsSaved', { count: comparison.monthsSaved })
      : t('loanDetail.comparison.paymentsSaved', {
          count: Math.max(comparison.paymentsSaved, 0),
        });
  };

  const interestSavedLabel = (comparison: ScenarioComparison | null) =>
    comparison ? formatCurrency(Math.max(0, comparison.interestSaved), currencyCode) : '—';

  const headerCell = 'px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400';

  return (
    <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
          {t('loanDetail.scenarios.title')}
        </h4>
        <Button variant="outline" size="sm" onClick={openSave} disabled={!activePlan}>
          {t('loanDetail.scenarios.saveCurrent')}
        </Button>
      </div>

      {scenarios.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.scenarios.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700 text-left">
                <th className={headerCell}>{t('loanDetail.scenarios.nameLabel')}</th>
                <th className={`${headerCell} text-right`}>
                  {t('loanDetail.comparison.newPayoff')}
                </th>
                <th className={`${headerCell} text-right`}>
                  {t('loanDetail.comparison.timeSaved')}
                </th>
                <th className={`${headerCell} text-right`}>
                  {t('loanDetail.comparison.interestSaved')}
                </th>
                <th className={headerCell} />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {scenarios.map((scenario) => {
                const comparison = comparisons.get(scenario.id) ?? null;
                return (
                  <tr key={scenario.id}>
                    <td className="px-3 py-2 align-top">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {scenario.name}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {describeScenario(scenario)}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-purple-600 dark:text-purple-400">
                      {payoffLabel(comparison)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-green-600 dark:text-green-400">
                      {timeSavedLabel(comparison)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-green-600 dark:text-green-400">
                      {interestSavedLabel(comparison)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onLoad(scenarioToPlan(scenario), scenario)}
                        >
                          {t('loanDetail.scenarios.load')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openRename(scenario)}>
                          {t('loanDetail.scenarios.rename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setScenarioToDelete(scenario)}
                        >
                          {t('loanDetail.scenarios.delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={nameModal !== null} onClose={() => setNameModal(null)} maxWidth="sm">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {nameModal?.mode === 'rename'
              ? t('loanDetail.scenarios.renameTitle')
              : t('loanDetail.scenarios.saveTitle')}
          </h3>
          <Input
            label={t('loanDetail.scenarios.nameLabel')}
            value={nameInput}
            maxLength={100}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitName();
            }}
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setNameModal(null)}>
              {t('loanDetail.scenarios.cancel')}
            </Button>
            <Button
              onClick={submitName}
              disabled={!nameInput.trim()}
              isLoading={isSubmitting}
            >
              {t('loanDetail.scenarios.save')}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={scenarioToDelete !== null}
        title={t('loanDetail.scenarios.deleteTitle')}
        message={t('loanDetail.scenarios.deleteMessage', {
          name: scenarioToDelete?.name ?? '',
        })}
        confirmLabel={t('loanDetail.scenarios.delete')}
        cancelLabel={t('loanDetail.scenarios.cancel')}
        variant="danger"
        onConfirm={confirmDelete}
        onCancel={() => setScenarioToDelete(null)}
      />
    </div>
  );
}
