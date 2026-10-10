'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import toast from 'react-hot-toast';
import { format, addMonths, subMonths } from 'date-fns';
import { Button } from '@/components/ui/Button';
import { ScheduledTransactionForm } from '@/components/scheduled-transactions/ScheduledTransactionForm';
import { CashFlowForecastChart } from '@/components/bills/CashFlowForecastChart';
import { ScheduledCalendarGrid } from '@/components/bills/ScheduledCalendarGrid';
import { ScheduledTransactionList } from '@/components/scheduled-transactions/ScheduledTransactionList';
import { BillsFilterPanel } from '@/components/scheduled-transactions/BillsFilterPanel';
import { OverrideEditorDialog } from '@/components/scheduled-transactions/OverrideEditorDialog';
import { OccurrenceDatePicker } from '@/components/scheduled-transactions/OccurrenceDatePicker';
import { PostTransactionDialog } from '@/components/scheduled-transactions/PostTransactionDialog';
import { DensityToggle } from '@/components/ui/DensityToggle';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { createCategoryFromInput } from '@/lib/category-create';
import { buildCategoryColorMap } from '@/lib/categoryUtils';
import { accountsApi } from '@/lib/accounts';
import { SelectedLoanOccurrence, ScheduledTransaction, ScheduledTransactionOverride } from '@/types/scheduled-transaction';
import { Category } from '@/types/category';
import { Account } from '@/types/account';
import { useBillsFilters } from '@/hooks/useBillsFilters';
import {
  filterScheduledTransactions,
  derivePayeesFromScheduledTransactions,
  deriveAccountsFromScheduledTransactions,
} from '@/lib/bills-filters';
import { parseLocalDate } from '@/lib/utils';
import { buildScheduledCalendarDays } from '@/lib/scheduled-calendar';
import { occurrenceKind } from '@/lib/scheduled-kind';
import { scheduleEffectiveAmount } from '@/lib/scheduled-effective-amount';
import { monthlyEquivalent } from '@/lib/frequency';
import type { FutureTransaction } from '@/lib/forecast';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { combineTotals, isComplete, sumConverted } from '@/lib/currency-total';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { useFormModal } from '@/hooks/useFormModal';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useHighlightParam } from '@/hooks/useHighlightTarget';

const logger = createLogger('Bills');

interface OverrideEditorState {
  isOpen: boolean;
  transaction: ScheduledTransaction | null;
  date: string;
  existingOverride: ScheduledTransactionOverride | null;
  // When set (post-reconciliation flow), seeds the Amount field with this value.
  prefillAmount: number | null;
  // A loan bill's occurrence as the server priced it at its own due date: the
  // editor opens on its amount and lines rather than the template's.
  loanOccurrence: SelectedLoanOccurrence | null;
}

/**
 * What a schedule's next occurrence IS, for every surface on this page: the
 * filter, the tab counts, the calendar chip and the monthly summary.
 *
 * One function, because these all sit beside a magnitude that comes from the
 * occurrence: classifying from the stored sign put a re-priced inflow in the
 * bills bucket and painted its chip red beside a green number. `occurrenceKind`
 * falls back to the schedule's sign when the occurrence cannot be priced, so an
 * unpriceable bill stays a bill rather than becoming a zero-amount reminder.
 */
function billKind(st: ScheduledTransaction) {
  return occurrenceKind(scheduleEffectiveAmount(st), st);
}

export default function BillsPage() {
  return (
    <ProtectedRoute>
      <BillsContent />
    </ProtectedRoute>
  );
}

function BillsContent() {
  const t = useTranslations('bills');
  const tc = useTranslations('common');
  // The two occurrence dialogs live in the scheduled-transaction domain and
  // their copy is in that catalog; the category toasts they raise from here
  // read from it rather than duplicating the same two strings under `bills`.
  const tsched = useTranslations('scheduledTransactions');
  const router = useRouter();
  const searchParams = useSearchParams();
  const postBillId = searchParams.get('postBillId');
  // Post-reconciliation deep links (from the Reconcile completion screen).
  const reconcileEditId = searchParams.get('reconcileEditId');
  const reconcileCreate = searchParams.get('reconcileCreate');
  const reconcileTransferAccountId = searchParams.get('reconcileTransferAccountId');
  const reconcileAmount = searchParams.get('reconcileAmount');
  // Passive deep-link target (e.g. the AI chat "view this bill" link): flash and
  // scroll to the row without opening the post flow that ?postBillId triggers.
  const highlightId = useHighlightParam();
  const { formatCurrency } = useNumberFormat();
  // The reader's reporting currency and the converter into it. The monthly net
  // spans one currency or none (issue #1247).
  const { convertToDefault, defaultCurrency, ratesUnavailable } =
    useExchangeRates();
  const [scheduledTransactions, setScheduledTransactions] = useState<ScheduledTransaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [futureTransactions, setFutureTransactions] = useState<FutureTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { showForm, editingItem: editingTransaction, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<ScheduledTransaction>();
  const [filterType, setFilterType] = useLocalStorage<'all' | 'bills' | 'deposits'>('monize-bills-filter-type', 'all');
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const filters = useBillsFilters();
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [overrideEditor, setOverrideEditor] = useState<OverrideEditorState>({
    isOpen: false,
    transaction: null,
    date: '',
    existingOverride: null,
    prefillAmount: null,
    loanOccurrence: null,
  });
  // Prefill state for a new transfer schedule created from the reconcile flow.
  const [createPrefill, setCreatePrefill] = useState<{
    transferAccountId: string;
    amount: number;
  } | null>(null);
  const [reconcileHandled, setReconcileHandled] = useState(false);
  const [overrideConfirm, setOverrideConfirm] = useState<{
    isOpen: boolean;
    transaction: ScheduledTransaction | null;
    overrideCount: number;
  }>({ isOpen: false, transaction: null, overrideCount: 0 });
  const [datePicker, setDatePicker] = useState<{
    isOpen: boolean;
    transaction: ScheduledTransaction | null;
    overrides: ScheduledTransactionOverride[];
  }>({ isOpen: false, transaction: null, overrides: [] });
  const [postDialog, setPostDialog] = useState<{
    isOpen: boolean;
    transaction: ScheduledTransaction | null;
  }>({ isOpen: false, transaction: null });
  const [autoOpenedPostId, setAutoOpenedPostId] = useState<string | null>(null);

  // A reload triggered by an AI/undo write (useOnAiAction / useOnUndoRedo)
  // supersedes any older load still in flight. apiCache stops an obsolete
  // response from re-entering the cache, but its original awaiter still
  // receives that response -- so without a latest-request guard here the older
  // invocation can overwrite the fresh React state when it happens to finish
  // last, restoring a pre-mutation FX forecast the cache already corrected
  // (issue #1167 close-out). "Latest load started wins", not "last completion
  // wins".
  const loadGenerationRef = useRef(0);

  const loadData = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    setIsLoading(true);
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;

      const [transactionsData, categoriesData, accountsData, futureData] = await Promise.all([
        scheduledTransactionsApi.getAll(),
        categoriesApi.getAll(),
        accountsApi.getAll(),
        transactionsApi.getAll({ startDate: tomorrowStr, limit: 200 }),
      ]);
      // A newer load started while this one was awaiting: discard this result
      // so it cannot overwrite the fresher state.
      if (generation !== loadGenerationRef.current) return;
      setScheduledTransactions(transactionsData);
      setCategories(categoriesData);
      setAccounts(accountsData);
      setFutureTransactions(
        futureData.data
          .filter(t => t.status !== 'VOID')
          .map(t => ({
            id: t.id,
            accountId: t.accountId,
            name: t.payeeName || t.payee?.name || t.description || 'Transaction',
            amount: Number(t.amount),
            date: t.transactionDate.split('T')[0],
          }))
      );
    } catch (error) {
      // A superseded request must not surface an obsolete failure over a newer
      // load that has already succeeded.
      if (generation !== loadGenerationRef.current) return;
      toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      logger.error(error);
    } finally {
      if (generation === loadGenerationRef.current) {
        setIsLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useOnUndoRedo(loadData);
  // Refresh on AI chat-bubble writes (the forecast depends on transactions).
  useOnAiAction(loadData);

  const handleCreateNew = () => {
    // Clear any stale reconcile prefill so a manual create starts blank.
    setCreatePrefill(null);
    openCreate();
  };

  const handleEdit = async (transaction: ScheduledTransaction) => {
    try {
      // Check if there are any overrides for this scheduled transaction
      const { hasOverrides, count } = await scheduledTransactionsApi.hasOverrides(transaction.id);
      if (hasOverrides) {
        // Show confirmation dialog
        setOverrideConfirm({
          isOpen: true,
          transaction,
          overrideCount: count,
        });
      } else {
        // No overrides, proceed directly to edit
        openEdit(transaction);
      }
    } catch (error) {
      // If check fails, proceed anyway
      logger.error('Failed to check overrides:', error);
      openEdit(transaction);
    }
  };

  const handleOverrideConfirmKeep = () => {
    // Keep overrides and edit the base template
    if (overrideConfirm.transaction) {
      openEdit(overrideConfirm.transaction);
    }
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleOverrideConfirmDelete = async () => {
    // Delete all overrides and then edit
    if (overrideConfirm.transaction) {
      try {
        await scheduledTransactionsApi.deleteAllOverrides(overrideConfirm.transaction.id);
        toast.success(t('toasts.overridesDeleted'));
        openEdit(overrideConfirm.transaction);
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.overridesDeleteFailed')));
        logger.error(error);
      }
    }
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  const handleOverrideConfirmCancel = () => {
    setOverrideConfirm({ isOpen: false, transaction: null, overrideCount: 0 });
  };

  // Clear any reconcile deep-link query params once the relevant dialog is done.
  const clearReconcileParams = () => {
    if (reconcileEditId || reconcileCreate || reconcileTransferAccountId || reconcileAmount) {
      router.replace('/bills');
    }
  };

  const handleFormClose = () => {
    close();
    if (createPrefill) {
      setCreatePrefill(null);
      clearReconcileParams();
    }
  };

  const handleFormSuccess = () => {
    close();
    if (createPrefill) {
      setCreatePrefill(null);
      clearReconcileParams();
    }
    loadData();
  };

  // Open the override editor directly on a schedule's next instance, optionally
  // prefilling the amount. Used by the post-reconciliation "update next payment"
  // deep link to skip the occurrence date picker.
  const openNextOccurrenceEditor = async (
    transaction: ScheduledTransaction,
    prefillAmount?: number,
  ) => {
    const date = (transaction.nextDueDate || '').split('T')[0];
    let existingOverride: ScheduledTransactionOverride | null = null;
    if (date) {
      try {
        existingOverride = await scheduledTransactionsApi.getOverrideByDate(
          transaction.id,
          date,
        );
      } catch (error) {
        logger.error('Failed to fetch override for next occurrence:', error);
      }
    }
    setOverrideEditor({
      isOpen: true,
      transaction,
      date,
      existingOverride,
      prefillAmount: prefillAmount ?? null,
      loanOccurrence: null,
    });
  };

  const handleEditOccurrence = async (transaction: ScheduledTransaction) => {
    // Fetch existing overrides to show which dates are modified (and what changed)
    let overrides: ScheduledTransactionOverride[] = [];
    try {
      overrides = await scheduledTransactionsApi.getOverrides(transaction.id);
    } catch (error) {
      logger.error('Failed to fetch overrides:', error);
    }

    // Show the date picker to let user choose which occurrence to edit
    setDatePicker({
      isOpen: true,
      transaction,
      overrides,
    });
  };

  const handleDatePickerSelect = async (date: string, loanOccurrence?: SelectedLoanOccurrence) => {
    const transaction = datePicker.transaction;
    if (!transaction) return;

    // Check if the selected date is an override date (user clicked on a modified occurrence)
    // or an original calculated date (user clicked on an unmodified occurrence)
    const overrideByOverrideDate = datePicker.overrides.find(o => o.overrideDate === date);
    const overrideByOriginalDate = datePicker.overrides.find(o => o.originalDate === date);

    // Close the date picker
    setDatePicker({ isOpen: false, transaction: null, overrides: [] });

    try {
      let existingOverride: ScheduledTransactionOverride | null = null;

      if (overrideByOverrideDate) {
        // User clicked on a date that is the override date - fetch the full override
        existingOverride = await scheduledTransactionsApi.getOverrideByDate(
          transaction.id,
          overrideByOverrideDate.originalDate
        );
      } else if (overrideByOriginalDate) {
        // User clicked on an original date that has been overridden (shouldn't happen with new logic)
        existingOverride = await scheduledTransactionsApi.getOverrideByDate(
          transaction.id,
          overrideByOriginalDate.originalDate
        );
      }

      setOverrideEditor({
        isOpen: true,
        transaction,
        date: overrideByOverrideDate?.originalDate || date, // Use original date if this was an override
        existingOverride,
        prefillAmount: null,
        loanOccurrence: loanOccurrence ?? null,
      });
    } catch (error) {
      logger.error('Failed to check for existing override:', error);
      // Open the editor anyway, without existing override data
      setOverrideEditor({
        isOpen: true,
        transaction,
        date,
        existingOverride: null,
        prefillAmount: null,
        loanOccurrence: loanOccurrence ?? null,
      });
    }
  };

  const handleDatePickerClose = () => {
    setDatePicker({ isOpen: false, transaction: null, overrides: [] });
  };

  // Create a category from text typed into either occurrence dialog's category
  // picker -- the plain Category field and each split line's own. The page owns
  // the category list both dialogs read, so it owns the creation; the created
  // row is returned so the dialog can select it, and appended here so it
  // appears in the picker.
  const createCategoryFromTypedName = useCallback(
    async (name: string): Promise<Category | null> => {
      try {
        const result = await createCategoryFromInput(name, categories);
        if (!result) return null;
        setCategories((prev) => [...prev, ...result.created]);
        toast.success(tsched('form.toasts.categoryCreated', { name: result.displayName }));
        return result.category;
      } catch (error) {
        logger.error('Failed to create category:', error);
        toast.error(getErrorMessage(error, tsched('form.toasts.categoryCreateFailed')));
        return null;
      }
    },
    [categories, tsched],
  );

  const handleOverrideEditorClose = () => {
    const wasReconcileDeepLink = overrideEditor.prefillAmount != null;
    setOverrideEditor({
      isOpen: false,
      transaction: null,
      date: '',
      existingOverride: null,
      prefillAmount: null,
      loanOccurrence: null,
    });
    if (wasReconcileDeepLink) {
      clearReconcileParams();
    }
  };

  const handleOverrideEditorSave = () => {
    loadData();
  };

  const handlePost = (transaction: ScheduledTransaction) => {
    setPostDialog({ isOpen: true, transaction });
  };

  const handlePostDialogClose = () => {
    setPostDialog({ isOpen: false, transaction: null });
    if (postBillId) {
      router.replace('/bills');
    }
  };

  const handlePostDialogPosted = () => {
    loadData();
  };

  // Auto-open the Post dialog when arriving from the dashboard widget
  // (e.g. /bills?postBillId=<id>). Adjust state during render (gated so it
  // runs once per id) to comply with the no-setState-in-effect rule.
  if (
    postBillId &&
    postBillId !== autoOpenedPostId &&
    !isLoading &&
    scheduledTransactions.length > 0
  ) {
    const target = scheduledTransactions.find((st) => st.id === postBillId);
    setAutoOpenedPostId(postBillId);
    if (target) {
      setPostDialog({ isOpen: true, transaction: target });
    }
  }

  // Handle post-reconciliation deep links. Adjust state during render (gated so
  // it runs once) to comply with the no-setState-in-effect rule. URL cleanup
  // happens when the opened dialog/modal closes.
  if (!reconcileHandled && !isLoading && (reconcileEditId || reconcileCreate)) {
    setReconcileHandled(true);
    const amount = reconcileAmount ? Number(reconcileAmount) : undefined;
    if (reconcileCreate && reconcileTransferAccountId) {
      setCreatePrefill({ transferAccountId: reconcileTransferAccountId, amount: amount ?? 0 });
      openCreate();
    } else if (reconcileEditId) {
      const target = scheduledTransactions.find((st) => st.id === reconcileEditId);
      if (target) {
        void openNextOccurrenceEditor(target, amount);
      } else {
        toast.error(t('toasts.notFound'));
      }
    }
  }

  // Distinct payees referenced by the loaded schedules, for the filter dropdown
  const payees = useMemo(
    () => derivePayeesFromScheduledTransactions(scheduledTransactions),
    [scheduledTransactions]
  );

  // Accounts that actually appear in Bills & Deposits, for the filter dropdown
  const billsAccounts = useMemo(
    () => deriveAccountsFromScheduledTransactions(scheduledTransactions, accounts),
    [scheduledTransactions, accounts]
  );

  // Filter by type and the Name/Payee/Account/Category filters, then sort by
  // effective date (considering overrides)
  const filteredTransactions = useMemo(() => {
    const byType = scheduledTransactions.filter((t) => {
      if (filterType === 'bills') return billKind(t) === 'bill';
      if (filterType === 'deposits') return billKind(t) === 'deposit';
      return true;
    });

    return filterScheduledTransactions(byType, filters.filterState).sort((a, b) => {
      const dateA = a.nextOverride?.overrideDate || a.nextDueDate || '';
      const dateB = b.nextOverride?.overrideDate || b.nextDueDate || '';
      return dateA.localeCompare(dateB);
    });
  }, [scheduledTransactions, filterType, filters.filterState]);

  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);

  // Calculate summary stats in a single pass (exclude transfers from bills/deposits)
  const summary = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let totalBills = 0;
    let totalDeposits = 0;
    let dueCount = 0;
    // One schedule whose current amount cannot be worked out makes the monthly
    // net unknowable rather than smaller (issue #1247). The count of schedules is
    // unaffected: how many bills there are is still known.
    let amountsResolved = true;
    // Each schedule's monthly equivalent kept WITH the currency it is in, and
    // converted only once the whole set is collected. A running `+=` sums a CAD
    // investment schedule beside a USD bill and labels the result with whichever
    // currency the reader happens to prefer -- the same defect the report and the
    // budget were fixed for (issue #1247 re-audit).
    const billComponents: { monthly: number; currencyCode: string }[] = [];
    const depositComponents: { monthly: number; currencyCode: string }[] = [];

    for (const t of scheduledTransactions) {
      // The amount this schedule would post today, not the persisted snapshot:
      // for an FX-sensitive schedule that scalar was calculated at an older rate.
      const effectiveAmount = scheduleEffectiveAmount(t);
      const effective = effectiveAmount.amount;
      const amount = effective ?? Number(t.amount);
      // The kind comes from the SAME occurrence the magnitude does. Reading the
      // stored sign here put a re-priced inflow of 20 into `monthlyBills` and
      // left the header's net 40 out: "an exchange rate cannot turn a bill into a
      // deposit" is true of one scalar times one rate and false of a mixed-sign
      // split parent, where only the investment line re-prices. `occurrenceKind`
      // falls back to the schedule's sign when the occurrence cannot be priced,
      // so an unpriceable bill is still a bill. Transfers move money between the
      // user's own accounts and a zero-amount reminder states no amount, so
      // neither is a bill or a deposit here.
      const kind = t.isActive ? billKind(t) : null;

      if (kind === 'unknown') {
        // Neither bucket can claim it, and the net cannot be complete without
        // it: the server could not derive which side of zero this occurrence
        // falls on (issue #1247 re-audit).
        amountsResolved = false;
      } else if (kind === 'bill') {
        totalBills++;
        if (effective === null) amountsResolved = false;
        else
          billComponents.push({
            monthly: monthlyEquivalent(Math.abs(amount), t.frequency),
            currencyCode: effectiveAmount.currencyCode,
          });
      } else if (kind === 'deposit') {
        totalDeposits++;
        if (effective === null) amountsResolved = false;
        else
          depositComponents.push({
            monthly: monthlyEquivalent(amount, t.frequency),
            currencyCode: effectiveAmount.currencyCode,
          });
      }

      if (t.isActive && t.nextDueDate) {
        try {
          const dueDate = parseLocalDate(t.nextDueDate);
          if (dueDate && !isNaN(dueDate.getTime()) && dueDate <= today) {
            dueCount++;
          }
        } catch { /* skip invalid dates */ }
      }
    }

    // Converted into ONE currency -- the reader's default, which is also what
    // the card's `formatCurrency` labels a bare amount with -- and a pair with
    // no rate withholds the net rather than shrinking it.
    const bills = sumConverted(
      billComponents,
      (c) => c.monthly,
      (c) => c.currencyCode,
      convertToDefault,
    );
    const deposits = sumConverted(
      depositComponents,
      (c) => c.monthly,
      (c) => c.currencyCode,
      convertToDefault,
    );
    // Incompleteness is the union: a complete deposits total beside a partial
    // bills total makes the net partial.
    const monthlyNet = combineTotals(
      [deposits, bills],
      ([depositTotal, billTotal]) => depositTotal - billTotal,
    );

    return {
      totalBills,
      totalDeposits,
      monthlyNet,
      // Two causes, and the card names BOTH when both apply: an occurrence the
      // server could not price sends the reader to the schedule, a missing
      // display rate to the Currencies page. A bare "unavailable" is a dead
      // end, and naming only one of two makes the reader fix it and watch
      // nothing change.
      monthlyAmountsComplete: amountsResolved && isComplete(monthlyNet),
      monthlyMissingRates: monthlyNet.missingCurrencies,
      monthlyHasUnpriceable: !amountsResolved,
      dueCount,
    };
  }, [scheduledTransactions, convertToDefault]);

  /**
   * Why the Monthly Net is withheld, or `undefined` when it is not.
   *
   * `ratesUnavailable` comes first because it makes the other diagnoses
   * untrustworthy: with the rate table still loading or its fetch failed, every
   * cross-currency conversion returns `null`, so "no exchange rate for CAD"
   * would be a statement about this request rather than about the user's rates --
   * an instruction to add a rate that is very likely already there.
   */
  const monthlyNetUnavailableHint = useMemo(() => {
    if (summary.monthlyAmountsComplete) return undefined;
    if (ratesUnavailable) return t('page.summaryNetRatesUnavailable');
    const missingRates = summary.monthlyMissingRates.length > 0;
    // Three cases, three catalog strings -- never two joined here. A sentence
    // built by concatenating fragments is one a translator cannot reorder or
    // punctuate, and the both-causes case is a real sentence in its own right.
    if (missingRates && summary.monthlyHasUnpriceable) {
      return t('page.summaryNetMissingRatesAndUnpriceable', {
        currencies: summary.monthlyMissingRates.join(', '),
      });
    }
    if (missingRates) {
      return t('page.summaryNetMissingRates', {
        currencies: summary.monthlyMissingRates.join(', '),
      });
    }
    return t('page.summaryNetUnpriceable');
  }, [summary, ratesUnavailable, t]);

  const calendarDays = useMemo(
    () => buildScheduledCalendarDays(scheduledTransactions, calendarMonth),
    [calendarMonth, scheduledTransactions],
  );

  return (
    <PageLayout>

      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl="https://github.com/kenlasko/monize/wiki/Bills-and-Deposits"
          actions={<Button onClick={handleCreateNew}>{t('page.newButton')}</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-6 mb-6">
          <SummaryCard label={t('page.summaryActiveBills')} value={summary.totalBills} icon={SummaryIcons.clipboard} />
          <SummaryCard label={t('page.summaryActiveDeposits')} value={summary.totalDeposits} icon={SummaryIcons.plus} />
          <SummaryCard
            label={t('page.summaryMonthlyNet')}
            value={
              summary.monthlyAmountsComplete
                ? formatCurrency(summary.monthlyNet.value, defaultCurrency)
                : t('page.summaryAmountUnavailable')
            }
            // A withheld figure names its cause, so the reader knows whether to
            // look at a schedule or add a rate (issue #1247 re-audit).
            hint={monthlyNetUnavailableHint}
            icon={SummaryIcons.money}
            valueColor={
              !summary.monthlyAmountsComplete
                ? 'default'
                : summary.monthlyNet.value >= 0
                  ? 'green'
                  : 'red'
            }
          />
          <SummaryCard
            label={t('page.summaryDueNow')}
            value={summary.dueCount}
            icon={SummaryIcons.clock}
            valueColor={summary.dueCount > 0 ? 'red' : 'default'}
          />
        </div>

        {/* Cash Flow Forecast Chart */}
        <ErrorBoundary fallback={
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6 mb-6">
            <p className="text-gray-500 dark:text-gray-400">{t('page.chartUnavailable')}</p>
          </div>
        }>
          <CashFlowForecastChart
            scheduledTransactions={scheduledTransactions}
            accounts={accounts}
            futureTransactions={futureTransactions}
            isLoading={isLoading}
          />
        </ErrorBoundary>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={handleFormClose} {...modalProps} maxWidth="6xl" className="p-6 !max-w-[69rem]">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? t('form.titleEdit') : t('form.titleNew')}
          </h2>
          <ScheduledTransactionForm
            key={editingTransaction?.id || (createPrefill ? 'new-prefill' : 'new')}
            scheduledTransaction={editingTransaction}
            initialMode={createPrefill ? 'transfer' : undefined}
            initialAmount={createPrefill?.amount}
            initialTransferAccountId={createPrefill?.transferAccountId}
            onSuccess={handleFormSuccess}
            onCancel={handleFormClose}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {viewMode === 'list' && (
          <div className="mb-6">
            <BillsFilterPanel
              filtersExpanded={filters.filtersExpanded}
              setFiltersExpanded={filters.setFiltersExpanded}
              nameSearch={filters.nameSearch}
              setNameSearch={filters.setNameSearch}
              selectedPayeeIds={filters.selectedPayeeIds}
              setSelectedPayeeIds={filters.setSelectedPayeeIds}
              selectedAccountIds={filters.selectedAccountIds}
              setSelectedAccountIds={filters.setSelectedAccountIds}
              selectedCategoryIds={filters.selectedCategoryIds}
              setSelectedCategoryIds={filters.setSelectedCategoryIds}
              accounts={billsAccounts}
              categories={categories}
              payees={payees}
              activeFilterCount={filters.activeFilterCount}
              onClearFilters={filters.clearFilters}
            />
          </div>
        )}

        {/* View Toggle + Filter Tabs */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg mb-6">
          <div className="border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-center justify-between">
            <nav className="-mb-px flex">
              <button
                onClick={() => setViewMode('list')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  viewMode === 'list'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                {t('viewTabs.list')}
              </button>
              <button
                onClick={() => setViewMode('calendar')}
                className={`py-4 px-6 text-sm font-medium border-b-2 ${
                  viewMode === 'calendar'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                {t('viewTabs.calendar')}
              </button>
            </nav>
            {viewMode === 'list' && (
              <div className="flex items-center pr-4 gap-2">
                <div className="hidden sm:flex gap-2">
                  {(['all', 'bills', 'deposits'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => setFilterType(type)}
                      className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        filterType === type
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {type === 'all' ? t('viewTabs.filterAll', { count: scheduledTransactions.length }) :
                       type === 'bills' ? t('viewTabs.filterBills', { count: scheduledTransactions.filter((st) => billKind(st) === 'bill').length }) :
                       t('viewTabs.filterDeposits', { count: scheduledTransactions.filter((st) => billKind(st) === 'deposit').length })}
                    </button>
                  ))}
                </div>
                {/* Density belongs to the list, so it sits with the list's own
                    controls and is absent from the calendar. `sm` -- the plain
                    borderless button every other table's toggle is, rather than
                    a filled chip: it is not a fourth filter beside All/Bills/
                    Deposits and must not read as one. It stays visible below
                    `sm`, where the type chips do not: the rows are still there
                    to tighten. */}
                <DensityToggle view="bills" />
              </div>
            )}
            {viewMode === 'calendar' && (
              <div className="flex items-center gap-2 px-4 py-2 sm:py-0 sm:pr-4 sm:pl-0 w-full sm:w-auto justify-center sm:justify-end">
                <button
                  onClick={() => setCalendarMonth(subMonths(calendarMonth, 1))}
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 min-w-[130px] text-center">
                  {format(calendarMonth, 'MMMM yyyy')}
                </span>
                <button
                  onClick={() => setCalendarMonth(addMonths(calendarMonth, 1))}
                  className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                <button
                  onClick={() => setCalendarMonth(new Date())}
                  className="ml-1 px-3 py-1 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md"
                >
                  {t('viewTabs.todayButton')}
                </button>
              </div>
            )}
          </div>
        </div>

        {viewMode === 'list' ? (
          /* Scheduled Transactions List */
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
            {isLoading ? (
              <LoadingSpinner text={t('page.loadingText')} />
            ) : (
              <ScheduledTransactionList
                transactions={filteredTransactions}
                onEdit={handleEdit}
                onEditOccurrence={handleEditOccurrence}
                onPost={handlePost}
                onRefresh={loadData}
                categoryColorMap={categoryColorMap}
                highlightId={highlightId}
              />
            )}
          </div>
        ) : (
          /* Calendar View */
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
            <ScheduledCalendarGrid days={calendarDays} onSelect={handleEdit} />
          </div>
        )}
      </main>

      {/* Occurrence Date Picker */}
      {datePicker.transaction && (
        <OccurrenceDatePicker
          isOpen={datePicker.isOpen}
          scheduledTransaction={datePicker.transaction}
          overrides={datePicker.overrides}
          onSelect={handleDatePickerSelect}
          onClose={handleDatePickerClose}
        />
      )}

      {/* Override Editor Dialog */}
      {overrideEditor.transaction && (
        <OverrideEditorDialog
          isOpen={overrideEditor.isOpen}
          scheduledTransaction={overrideEditor.transaction}
          overrideDate={overrideEditor.date}
          categories={categories}
          accounts={accounts}
          existingOverride={overrideEditor.existingOverride}
          prefillAmount={overrideEditor.prefillAmount}
          loanOccurrence={overrideEditor.loanOccurrence}
          onClose={handleOverrideEditorClose}
          onSave={handleOverrideEditorSave}
          onCreateCategory={createCategoryFromTypedName}
        />
      )}

      {/* Post Transaction Dialog */}
      {postDialog.transaction && (
        <PostTransactionDialog
          isOpen={postDialog.isOpen}
          scheduledTransaction={postDialog.transaction}
          categories={categories}
          accounts={accounts}
          scheduledTransactions={scheduledTransactions}
          futureTransactions={futureTransactions}
          onClose={handlePostDialogClose}
          onPosted={handlePostDialogPosted}
          onCreateCategory={createCategoryFromTypedName}
        />
      )}

      {/* Override Confirmation Dialog */}
      <Modal isOpen={overrideConfirm.isOpen} onClose={handleOverrideConfirmCancel} maxWidth="lg" className="px-6 py-5">
        <div className="mb-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {t('overrideConfirm.title')}
          </h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t('overrideConfirm.message', { count: overrideConfirm.overrideCount })}
          </p>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            {t('overrideConfirm.question')}
          </p>
        </div>
        <div className="flex flex-col space-y-3 sm:flex-row sm:space-y-0 sm:space-x-3 sm:justify-end">
          <Button variant="outline" onClick={handleOverrideConfirmCancel}>
            {tc('cancel')}
          </Button>
          <Button variant="outline" onClick={handleOverrideConfirmKeep}>
            {t('overrideConfirm.keepButton')}
          </Button>
          <Button onClick={handleOverrideConfirmDelete} className="bg-red-600 hover:bg-red-700">
            {t('overrideConfirm.deleteButton')}
          </Button>
        </div>
      </Modal>
    </PageLayout>
  );
}
