'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { useFormModal } from '@/hooks/useFormModal';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import { newClientId } from '@/lib/client-id';
import { moneyDecimalsForCurrency, sumMoney } from '@/lib/format';
import type {
  BudgetBucket,
  CreateBudgetBucketData,
  UpdateBudgetBucketData,
} from '@/types/budget';
import { BudgetBucketForm } from './BudgetBucketForm';
import {
  BUDGET_BUCKET_PRESETS,
  findBudgetBucketPreset,
  materializeBudgetBucketPreset,
  type BudgetBucketDraft,
  type BudgetBucketEditorRow,
  type BudgetBucketPresetId,
} from './utils/budget-bucket-presets';

/** Design decision 10: at most 12 buckets per budget. */
export const BUDGET_BUCKET_LIMIT = 12;

interface BudgetBucketEditorBaseProps {
  /** The budget's currency: amount targets and caps are in it. */
  currencyCode: string;
}

/** The wizard: the list lives in the host's state and nothing is saved here. */
export interface BudgetBucketEditorMemoryProps extends BudgetBucketEditorBaseProps {
  mode: 'memory';
  rows: BudgetBucketEditorRow[];
  onChange: (rows: BudgetBucketEditorRow[]) => void;
}

/**
 * The edit page: every change is a request. Each callback rejects with the
 * API error when the server refuses, and the editor shows that message.
 */
export interface BudgetBucketEditorPersistedProps extends BudgetBucketEditorBaseProps {
  mode: 'persisted';
  buckets: BudgetBucket[];
  onCreate: (data: CreateBudgetBucketData) => Promise<unknown>;
  onUpdate: (bucketId: string, data: UpdateBudgetBucketData) => Promise<unknown>;
  onDelete: (bucketId: string) => Promise<unknown>;
  /**
   * Called once after an action that wrote anything (a preset makes several
   * writes), so the host re-reads the budget a single time.
   */
  onWritten: () => void;
}

export type BudgetBucketEditorProps = BudgetBucketEditorMemoryProps | BudgetBucketEditorPersistedProps;

function bucketToRow(bucket: BudgetBucket): BudgetBucketEditorRow {
  return {
    key: bucket.id,
    name: bucket.name,
    targetType: bucket.targetType,
    targetValue: Number(bucket.targetValue),
    carryOver: bucket.carryOver,
    carryCap: bucket.carryCap === null ? null : Number(bucket.carryCap),
  };
}

function toCreateData(draft: BudgetBucketDraft, sortOrder: number): CreateBudgetBucketData {
  return {
    name: draft.name,
    targetType: draft.targetType,
    targetValue: draft.targetValue,
    carryOver: draft.carryOver,
    ...(draft.carryCap !== null ? { carryCap: draft.carryCap } : {}),
    sortOrder,
  };
}

function toUpdateData(draft: BudgetBucketDraft): UpdateBudgetBucketData {
  return {
    name: draft.name,
    targetType: draft.targetType,
    targetValue: draft.targetValue,
    carryOver: draft.carryOver,
    carryCap: draft.carryCap,
  };
}

export function BudgetBucketEditor(props: BudgetBucketEditorProps) {
  const { currencyCode } = props;
  const t = useTranslations('budgets');
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing,
    modalProps,
    setFormDirty,
    unsavedChangesDialog,
    formSubmitRef,
  } = useFormModal<BudgetBucketEditorRow>();
  const [deletingRow, setDeletingRow] = useState<BudgetBucketEditorRow | null>(null);
  const [pendingPreset, setPendingPreset] = useState<BudgetBucketPresetId | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const rows = props.mode === 'memory' ? props.rows : props.buckets.map(bucketToRow);
  const atLimit = rows.length >= BUDGET_BUCKET_LIMIT;
  const otherNames = rows.filter((row) => row.key !== editingItem?.key).map((row) => row.name);

  // A sum of the person's own targets, by kind; not a bucket figure (INV-BUDGET-001).
  const percentTotal = sumMoney(
    rows.filter((row) => row.targetType === 'PERCENT').map((row) => row.targetValue),
    2,
  );
  const amountTotal = sumMoney(
    rows.filter((row) => row.targetType === 'AMOUNT').map((row) => row.targetValue),
    moneyDecimalsForCurrency(currencyCode),
  );

  const nextSortOrder = (offset: number) =>
    props.mode === 'persisted'
      ? Math.max(-1, ...props.buckets.map((b) => b.sortOrder)) + 1 + offset
      : offset;

  const handleFormSubmit = async (draft: BudgetBucketDraft) => {
    if (props.mode === 'memory') {
      props.onChange(
        editingItem
          ? rows.map((row) => (row.key === editingItem.key ? { ...draft, key: row.key } : row))
          : [...rows, { ...draft, key: newClientId() }],
      );
      close();
      return;
    }
    try {
      if (editingItem) {
        await props.onUpdate(editingItem.key, toUpdateData(draft));
        toast.success(t('bucketEditor.toasts.updated'));
      } else {
        await props.onCreate(toCreateData(draft, nextSortOrder(0)));
        toast.success(t('bucketEditor.toasts.created'));
      }
      close();
      props.onWritten();
    } catch (err) {
      toast.error(getErrorMessage(err, t('bucketEditor.toasts.saveFailed')));
    }
  };

  const handleDelete = async () => {
    if (!deletingRow) return;
    const target = deletingRow;
    setDeletingRow(null);
    if (props.mode === 'memory') {
      props.onChange(rows.filter((row) => row.key !== target.key));
      return;
    }
    setIsBusy(true);
    try {
      await props.onDelete(target.key);
      toast.success(t('bucketEditor.toasts.deleted'));
      props.onWritten();
    } catch (err) {
      toast.error(getErrorMessage(err, t('bucketEditor.toasts.deleteFailed')));
    } finally {
      setIsBusy(false);
    }
  };

  const applyPreset = async (id: BudgetBucketPresetId) => {
    const next = materializeBudgetBucketPreset(findBudgetBucketPreset(id), t, newClientId);
    if (props.mode === 'memory') {
      props.onChange(next);
      return;
    }
    setIsBusy(true);
    let wrote = false;
    try {
      // Sequential on purpose: the 12-bucket limit is checked per write.
      for (const row of rows) {
        await props.onDelete(row.key);
        wrote = true;
      }
      for (const [index, row] of next.entries()) {
        await props.onCreate(toCreateData(row, index));
        wrote = true;
      }
      toast.success(t('bucketEditor.toasts.presetApplied'));
    } catch (err) {
      toast.error(getErrorMessage(err, t('bucketEditor.toasts.presetFailed')));
    } finally {
      setIsBusy(false);
      if (wrote) props.onWritten();
    }
  };

  const choosePreset = (id: BudgetBucketPresetId) => {
    if (rows.length === 0) {
      // Starting from scratch on an empty list changes nothing.
      if (findBudgetBucketPreset(id).buckets.length === 0) return;
      void applyPreset(id);
    } else {
      setPendingPreset(id);
    }
  };

  const confirmPreset = () => {
    const id = pendingPreset;
    setPendingPreset(null);
    if (id) void applyPreset(id);
  };

  const targetCaption = (row: BudgetBucketEditorRow) =>
    row.targetType === 'PERCENT'
      ? t('bucketEditor.row.percentTarget', { percent: formatPercentTrimmed(row.targetValue) })
      : t('bucketEditor.row.amountTarget', { amount: formatCurrency(row.targetValue, currencyCode) });

  const carryCaption = (row: BudgetBucketEditorRow) => {
    if (!row.carryOver) return t('bucketEditor.row.noCarry');
    return row.carryCap === null
      ? t('bucketEditor.row.carries')
      : t('bucketEditor.row.carriesUpTo', { cap: formatCurrency(row.carryCap, currencyCode) });
  };

  return (
    <div className="space-y-4">
      <div>
        <span id="bucket-preset-label" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          {t('bucketEditor.presetLabel')}
        </span>
        <div role="group" aria-labelledby="bucket-preset-label" className="flex flex-wrap gap-2">
          {BUDGET_BUCKET_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
              disabled={isBusy}
              onClick={() => choosePreset(preset.id)}
            >
              {t(preset.labelKey)}
            </Button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState title={t('bucketEditor.empty.title')} description={t('bucketEditor.empty.description')} />
      ) : (
        <ul className="space-y-2" aria-label={t('bucketEditor.listLabel')}>
          {rows.map((row) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center justify-between gap-2 p-3 border border-gray-200 dark:border-gray-700 rounded-lg"
            >
              <div className="min-w-0">
                <p className="font-medium text-gray-900 dark:text-gray-100 break-words">{row.name}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t('bucketEditor.row.caption', { target: targetCaption(row), carry: carryCaption(row) })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  aria-label={t('bucketEditor.row.editLabel', { name: row.name })}
                  onClick={() => openEdit(row)}
                >
                  {t('bucketEditor.row.edit')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isBusy}
                  aria-label={t('bucketEditor.row.deleteLabel', { name: row.name })}
                  onClick={() => setDeletingRow(row)}
                >
                  {t('bucketEditor.row.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400" data-testid="bucket-target-summary">
          {t('bucketEditor.summary', {
            percent: formatPercentTrimmed(percentTotal),
            amount: formatCurrency(amountTotal, currencyCode),
          })}
        </p>
      )}

      <div>
        <Button
          type="button"
          className="w-full sm:w-auto"
          disabled={atLimit || isBusy}
          aria-describedby={atLimit ? 'bucket-limit-note' : undefined}
          onClick={openCreate}
        >
          {t('bucketEditor.add')}
        </Button>
        {atLimit && (
          <p id="bucket-limit-note" className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('bucketEditor.limitReached', { max: BUDGET_BUCKET_LIMIT })}
          </p>
        )}
      </div>

      <Modal
        isOpen={showForm}
        onClose={close}
        {...modalProps}
        title={isEditing && editingItem ? t('bucketEditor.editTitle', { name: editingItem.name }) : t('bucketEditor.newTitle')}
        maxWidth="lg"
        className="p-6"
      >
        <BudgetBucketForm
          key={editingItem?.key ?? 'new'}
          bucket={editingItem}
          currencyCode={currencyCode}
          otherNames={otherNames}
          onSubmit={handleFormSubmit}
          onCancel={close}
          onDirtyChange={setFormDirty}
          submitRef={formSubmitRef}
        />
      </Modal>
      <UnsavedChangesDialog {...unsavedChangesDialog} />

      <ConfirmDialog
        isOpen={deletingRow !== null}
        title={t('bucketEditor.delete.title')}
        message={t('bucketEditor.delete.message', { name: deletingRow?.name ?? '' })}
        confirmLabel={t('bucketEditor.delete.confirm')}
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeletingRow(null)}
      />

      <ConfirmDialog
        isOpen={pendingPreset !== null}
        title={t('bucketEditor.replace.title')}
        message={
          pendingPreset === 'SCRATCH'
            ? t('bucketEditor.replace.clearMessage')
            : t('bucketEditor.replace.message', {
                preset: pendingPreset ? t(findBudgetBucketPreset(pendingPreset).labelKey) : '',
              })
        }
        confirmLabel={t('bucketEditor.replace.confirm')}
        variant="warning"
        onConfirm={confirmPreset}
        onCancel={() => setPendingPreset(null)}
      />
    </div>
  );
}
