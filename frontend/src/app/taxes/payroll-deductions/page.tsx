'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { ChevronLeftIcon, ChevronDownIcon, ReceiptPercentIcon } from '@heroicons/react/24/outline';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageHeader } from '@/components/layout/PageHeader';
import { PageLayout } from '@/components/layout/PageLayout';
import { PayrollDeductionPreviousPeriods } from '@/components/taxes/PayrollDeductionPreviousPeriods';
import { PayrollDeductionRuleList } from '@/components/taxes/PayrollDeductionRuleList';
import { PayrollDeductionYearToDate } from '@/components/taxes/PayrollDeductionYearToDate';
import { Button } from '@/components/ui/Button';
import { CARD_CLASS } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { categoriesApi } from '@/lib/categories';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { payrollDeductionsApi } from '@/lib/payroll-deductions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import type { Category } from '@/types/category';
import type { CreatePayrollDeductionRulesData, PayrollDeductionRule } from '@/types/payroll-deduction';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import { docsUrl } from '@/lib/docs-links';

const PayrollDeductionRuleForm = dynamic(
  () => import('@/components/taxes/PayrollDeductionRuleForm').then((m) => m.PayrollDeductionRuleForm),
  { ssr: false },
);

const logger = createLogger('PayrollDeductions');

export default function PayrollDeductionsPage() {
  return (
    <ProtectedRoute>
      <PayrollDeductionsContent />
    </ProtectedRoute>
  );
}

function PayrollDeductionsContent() {
  const t = useTranslations('taxes.payroll');
  const tc = useTranslations('common');
  const [rules, setRules] = useState<PayrollDeductionRule[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showYearToDate, setShowYearToDate] = useState(false);
  const [showPreviousPeriods, setShowPreviousPeriods] = useState(false);
  const [deleteRule, setDeleteRule] = useState<PayrollDeductionRule | null>(null);
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
  } = useFormModal<PayrollDeductionRule>();

  const fetchAll = useCallback(() => {
    const run = async () => {
      try {
        const [ruleRows, scheduledRows, categoryRows] = await Promise.all([
          payrollDeductionsApi.list(),
          scheduledTransactionsApi.getAll(),
          categoriesApi.getAll(),
        ]);
        setRules(ruleRows);
        setScheduled(scheduledRows);
        setCategories(categoryRows);
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.loadFailed')));
        logger.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  const reload = useCallback(() => {
    setIsLoading(true);
    return fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useOnUndoRedo(reload);
  useOnAiAction(reload);

  // The form always speaks in lines; an edit is the one-line case.
  const handleFormSubmit = async (data: CreatePayrollDeductionRulesData) => {
    try {
      if (editingItem) {
        const [line] = data.lines;
        await payrollDeductionsApi.update(editingItem.id, {
          scheduledTransactionId: data.scheduledTransactionId,
          resetPeriod: data.resetPeriod,
          resetDate: data.resetDate,
          ...line,
        });
        toast.success(t('toasts.updated'));
      } else {
        const created = await payrollDeductionsApi.createMany(data);
        toast.success(t('toasts.created', { count: created.length }));
      }
      close();
      reload();
    } catch (error) {
      toast.error(getErrorMessage(error, editingItem ? t('toasts.updateFailed') : t('toasts.createFailed')));
      throw error;
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteRule) return;
    try {
      await payrollDeductionsApi.delete(deleteRule.id);
      toast.success(t('toasts.deleted'));
      setRules((prev) => prev.filter((r) => r.id !== deleteRule.id));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeleteRule(null);
    }
  };

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <Link
          href="/taxes"
          className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
          {t('backToTaxes')}
        </Link>
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          helpUrl={docsUrl('payrollDeductions')}
          actions={
            <Button onClick={openCreate} {...tourAnchor(TOUR_ANCHORS.payrollNewRuleButton)}>
              {t('newButton')}
            </Button>
          }
        />

        <Modal
          isOpen={showForm}
          onClose={close}
          {...modalProps}
          maxWidth="lg"
          padding="md"
          allowOverflow
          title={isEditing ? t('modal.editTitle') : t('modal.newTitle')}
        >
          <PayrollDeductionRuleForm
            rule={editingItem}
            scheduledTransactions={scheduled}
            categories={categories}
            existingRules={rules}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        <ConfirmDialog
          isOpen={deleteRule !== null}
          title={t('delete.title')}
          message={t('delete.message', {
            category: deleteRule?.categoryName ?? '',
            bill: deleteRule?.scheduledTransactionName ?? '',
          })}
          confirmLabel={tc('delete')}
          variant="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteRule(null)}
        />

        <div className={`${CARD_CLASS} overflow-hidden`} {...tourAnchor(TOUR_ANCHORS.payrollRulesList)}>
          {isLoading ? (
            <LoadingSpinner text={t('loading')} />
          ) : rules.length === 0 ? (
            <EmptyState
              icon={<ReceiptPercentIcon />}
              title={t('emptyState.title')}
              description={t('emptyState.body')}
              action={<Button onClick={openCreate}>{t('emptyState.createButton')}</Button>}
            />
          ) : (
            <PayrollDeductionRuleList rules={rules} onEdit={openEdit} onDelete={setDeleteRule} />
          )}
        </div>

        {!isLoading && rules.length > 0 && (
          <div className="mt-4">
            {/* Collapsed by default: the figures are a detail behind the rules. */}
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setShowYearToDate((open) => !open)}
              aria-expanded={showYearToDate}
            >
              <ChevronDownIcon
                className={`h-4 w-4 mr-1 transition-transform motion-reduce:transition-none ${showYearToDate ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
              {showYearToDate ? t('yearToDate.hide') : t('yearToDate.show')}
            </Button>
            {showYearToDate && (
              <div className={`${CARD_CLASS} overflow-hidden mt-4`}>
                <PayrollDeductionYearToDate rules={rules} />
              </div>
            )}
          </div>
        )}

        {!isLoading && rules.length > 0 && (
          <div className="mt-4">
            {/* Collapsed by default, loaded when opened: a look back, not a decision. */}
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setShowPreviousPeriods((open) => !open)}
              aria-expanded={showPreviousPeriods}
            >
              <ChevronDownIcon
                className={`h-4 w-4 mr-1 transition-transform motion-reduce:transition-none ${showPreviousPeriods ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
              {showPreviousPeriods ? t('previousPeriods.hide') : t('previousPeriods.show')}
            </Button>
            {showPreviousPeriods && (
              <div className={`${CARD_CLASS} overflow-hidden mt-4`}>
                <PayrollDeductionPreviousPeriods />
              </div>
            )}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
