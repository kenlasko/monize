'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { OverpaymentPlan } from '@/lib/loan-schedule';
import { loanScenariosApi, planToScenarioData, scenarioToPlan } from '@/lib/loan-scenarios';
import { LoanScenario } from '@/types/loan-scenario';
import { getErrorMessage } from '@/lib/errors';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface SavedScenariosPanelProps {
  accountId: string;
  scenarios: LoanScenario[];
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
  activePlan,
  onLoad,
  onScenariosChanged,
}: SavedScenariosPanelProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();

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
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {scenarios.map((scenario) => (
            <li key={scenario.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {scenario.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {describeScenario(scenario)}
                </p>
              </div>
              <div className="flex items-center gap-1">
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
            </li>
          ))}
        </ul>
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
