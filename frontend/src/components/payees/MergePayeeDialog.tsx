'use client';

import { useState, useMemo, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Payee } from '@/types/payee';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Combobox } from '@/components/ui/Combobox';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';
import { getErrorMessage } from '@/lib/errors';
import { payeeOptionIcon } from '@/components/payees/withPayeeIcons';

interface MergePayeeDialogProps {
  isOpen: boolean;
  sourcePayee: Payee | null;
  allPayees: Payee[];
  onClose: () => void;
  onSuccess: () => void;
}

export function MergePayeeDialog({
  isOpen,
  sourcePayee,
  allPayees,
  onClose,
  onSuccess,
}: MergePayeeDialogProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const [targetPayeeId, setTargetPayeeId] = useState('');
  const [addAsAlias, setAddAsAlias] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [impact, setImpact] = useState<{ rules: number; reports: number } | null>(null);
  const sourceId = sourcePayee?.id;

  // The rules and reports that name the source are repointed by the merge; say how many.
  useEffect(() => {
    if (!isOpen || !sourceId) return;
    let cancelled = false;
    payeesApi
      .getMergeImpact(sourceId)
      .then((r) => !cancelled && setImpact(r))
      .catch(() => !cancelled && setImpact(null));
    return () => {
      cancelled = true;
    };
  }, [isOpen, sourceId]);

  const payeeOptions = useMemo(() => {
    return allPayees
      .filter((p) => p.id !== sourcePayee?.id && p.isActive)
      .map((p) => ({
        value: p.id,
        label: p.name,
        icon: payeeOptionIcon(p),
      }));
  }, [allPayees, sourcePayee]);

  const targetPayee = allPayees.find((p) => p.id === targetPayeeId);

  const handleMerge = async () => {
    if (!sourcePayee || !targetPayeeId) return;

    setIsSubmitting(true);
    try {
      const result = await payeesApi.mergePayees({
        targetPayeeId,
        sourcePayeeId: sourcePayee.id,
        addAsAlias,
      });

      const parts: string[] = [];
      if (result.transactionsMigrated > 0) {
        parts.push(t('merge.toasts.transactionsMigrated', { count: result.transactionsMigrated }));
      }
      if (result.aliasAdded) {
        parts.push(t('merge.toasts.aliasAdded'));
      }
      parts.push(t('merge.toasts.sourceDeleted', { name: sourcePayee.name }));

      toast.success(t('merge.toasts.merged', { target: targetPayee?.name ?? '', details: parts.join(', ') }));
      setTargetPayeeId('');
      onClose();
      onSuccess();
    } catch (error) {
      toast.error(getErrorMessage(error, t('merge.toasts.failed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setTargetPayeeId('');
    setAddAsAlias(true);
    onClose();
  };

  if (!sourcePayee) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      maxWidth="lg"
      className="p-6"
      allowOverflow
      title={t('merge.title')}
    >

      <div className="space-y-4">
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
            {t('merge.mergeFromLabel')}
          </p>
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {sourcePayee.name}
          </p>
          {sourcePayee.transactionCount !== undefined && sourcePayee.transactionCount > 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t('merge.transactionCount', { count: sourcePayee.transactionCount })}
            </p>
          )}
        </div>

        <Combobox
          label={t('merge.mergeIntoLabel')}
          placeholder="Select target payee..."
          options={payeeOptions}
          value={targetPayeeId}
          onChange={setTargetPayeeId}
        />

        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={addAsAlias}
            onChange={(e) => setAddAsAlias(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          {t('merge.addAsAliasLabel', { name: sourcePayee.name })}
        </label>

        {targetPayee && (
          <div className="bg-blue-50 dark:bg-blue-900/30 rounded-lg p-4 text-sm">
            <p className="font-medium text-blue-800 dark:text-blue-200 mb-2">
              {t('merge.willLabel')}
            </p>
            <ul className="list-disc pl-5 text-blue-700 dark:text-blue-300 space-y-1">
              <li>
                {t('merge.willMoveTransactions', { source: sourcePayee.name, target: targetPayee.name })}
              </li>
              {impact && impact.rules > 0 && (
                <li>
                  {t('merge.willRepointRules', {
                    count: impact.rules,
                    source: sourcePayee.name,
                    target: targetPayee.name,
                  })}
                </li>
              )}
              {impact && impact.reports > 0 && (
                <li>
                  {t('merge.willRepointReports', {
                    count: impact.reports,
                    source: sourcePayee.name,
                    target: targetPayee.name,
                  })}
                </li>
              )}
              {addAsAlias && (
                <li>
                  {t('merge.willAddAlias', { source: sourcePayee.name })}
                </li>
              )}
              <li>{t('merge.willDelete', { source: sourcePayee.name })}</li>
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={handleMerge}
            disabled={!targetPayeeId || isSubmitting}
          >
            {isSubmitting ? t('merge.merging') : t('merge.mergeButton')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
