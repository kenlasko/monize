'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useDateFormat } from '@/hooks/useDateFormat';
import { getLocalDateString } from '@/lib/utils';
import { CustomRecurrence, CustomRecurrenceUnit } from '@/lib/custom-recurrence';
import { formatList } from '@/lib/custom-recurrence-label';
import {
  defaultCustomRecurrence,
  isOnCustomPattern,
  orphanedOverrideDates,
  savedNextDueDate,
  StoredSchedule,
} from '@/lib/custom-recurrence-edit';
import { LOAN_LIKE_ACCOUNT_TYPES } from '@/lib/minor-unit-booking';
import { FREQUENCY_VALUES, FrequencyType, ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Account } from '@/types/account';
import type { CustomRecurrenceEditorProps } from './CustomRecurrenceEditor';

interface UseCustomRecurrenceFieldArgs {
  /** The schedule being edited; absent for a new one. */
  scheduledTransaction?: ScheduledTransaction;
  /** The accounts the form loaded, which say whether a loan pays by this schedule. */
  accounts: readonly Account[];
  /** The transfer accounts of the split lines this save sends; empty outside split mode. */
  splitTransferAccountIds: readonly (string | null | undefined)[];
  frequency: FrequencyType | undefined;
  nextDueDate: string | undefined;
  rule: CustomRecurrence | null | undefined;
  setRule: (rule: CustomRecurrence) => void;
}

export interface CustomRecurrenceField {
  frequencyOptions: { value: FrequencyType; label: string }[];
  /** For the frequency select's `register` `onChange`: seeds a rule the first time Custom is picked. */
  onFrequencyChange: (frequency: string) => void;
  /** The editor's props while the frequency is Custom, else null. */
  editorProps: CustomRecurrenceEditorProps | null;
  /**
   * The date the server will store as the next occurrence, beside the due date
   * while the frequency is Custom, with a hint when it is off the pattern.
   */
  occurrenceCaption: string | null;
  /** Why the server refuses Custom for this schedule, while Custom is chosen; else null. */
  customRefusal: string | null;
  /** The edited occurrences this save would delete, named, or null. */
  orphanWarning: string | null;
}

/**
 * The scheduled-transaction form's Custom frequency (docs/specs/custom-recurrence.md):
 * which frequencies the selector offers, the rule a first Custom choice
 * starts from, each unit's choices kept while the user switches units, the
 * date the pattern posts first, and the warning that a save deletes edited
 * occurrences that no longer fall on the schedule (section 5).
 */
export function useCustomRecurrenceField({
  scheduledTransaction,
  accounts,
  splitTransferAccountIds,
  frequency,
  nextDueDate,
  rule,
  setRule,
}: UseCustomRecurrenceFieldArgs): CustomRecurrenceField {
  const t = useTranslations('scheduledTransactions');
  const locale = useLocale();
  const { formatDate } = useDateFormat();
  const weekStartsOn = usePreferencesStore((s) => s.preferences?.weekStartsOn) ?? 1;
  // Each unit's last choices, so Weekly -> Monthly -> Weekly comes back to the
  // weekdays the user had picked.
  const [drafts, setDrafts] = useState<Partial<Record<CustomRecurrenceUnit, CustomRecurrence>>>(() =>
    scheduledTransaction?.customRecurrence
      ? { [scheduledTransaction.customRecurrence.unit]: scheduledTransaction.customRecurrence }
      : {},
  );

  const seedDate = nextDueDate || getLocalDateString();

  // Amortisation and payroll deduction pooling assume a fixed cadence, and the
  // API refuses Custom there (spec section 5): a loan's payment schedule, a
  // split with a leg into a loan-like account, a payroll bill. The option stays
  // while it is the schedule's own frequency or the current choice, so the
  // selector can show it, and the refusal then says why.
  const isLoanPayment =
    (!!scheduledTransaction && accounts.some((a) => a.scheduledTransactionId === scheduledTransaction.id)) ||
    splitTransferAccountIds.some(
      (id) => !!id && LOAN_LIKE_ACCOUNT_TYPES.has(accounts.find((a) => a.id === id)?.accountType ?? ''),
    );
  const isPayroll = (scheduledTransaction?.payrollDeductions?.length ?? 0) > 0;
  const refusalKey = isLoanPayment
    ? 'customRecurrence.notForLoan'
    : isPayroll
      ? 'customRecurrence.notForPayroll'
      : null;
  const offersCustom = !refusalKey || scheduledTransaction?.frequency === 'CUSTOM' || frequency === 'CUSTOM';
  const frequencyOptions = FREQUENCY_VALUES.filter((value) => value !== 'CUSTOM' || offersCustom).map((value) => ({
    value,
    label: t(`frequency.${value}`),
  }));
  const customRefusal = frequency === 'CUSTOM' && refusalKey ? t(refusalKey) : null;

  const onFrequencyChange = (next: string) => {
    if (next === 'CUSTOM' && !rule) {
      setRule(drafts.WEEK ?? defaultCustomRecurrence('WEEK', seedDate, weekStartsOn));
    }
  };

  const onUnitChange = (unit: CustomRecurrenceUnit) => {
    if (rule) setDrafts((prev) => ({ ...prev, [rule.unit]: rule }));
    setRule(drafts[unit] ?? defaultCustomRecurrence(unit, seedDate, weekStartsOn));
  };

  const isCustom = frequency === 'CUSTOM';
  // A Custom schedule that arrived without a rule (a defect the API refuses to
  // write) shows the starting rule; the form refuses the save until the user
  // picks one, which writes it.
  const editorProps: CustomRecurrenceEditorProps | null = isCustom
    ? {
        rule: rule ?? defaultCustomRecurrence('WEEK', seedDate, weekStartsOn),
        onChange: setRule,
        onUnitChange,
        weekStartsOn,
        idPrefix: 'scheduled',
      }
    : null;

  const stored: StoredSchedule | undefined = scheduledTransaction && {
    frequency: scheduledTransaction.frequency,
    nextDueDate: scheduledTransaction.nextDueDate,
    startDate: scheduledTransaction.startDate,
    customRecurrence: scheduledTransaction.customRecurrence,
  };
  const edited = frequency
    ? { frequency, nextDueDate, customRecurrence: frequency === 'CUSTOM' ? rule : null }
    : null;

  // The date the server stores (spec section 5): snapped onto the pattern on a
  // create or a rule change, else the typed date as it is, even off the
  // pattern, in which case later occurrences still follow it.
  const savedDate = isCustom && edited ? savedNextDueDate(edited, stored) : null;
  const offPattern =
    !!savedDate && !isOnCustomPattern(savedDate, rule, scheduledTransaction?.startDate ?? savedDate);
  const occurrenceCaption = savedDate
    ? t(
        offPattern
          ? 'customRecurrence.nextOccurrenceOffPattern'
          : scheduledTransaction
            ? 'customRecurrence.nextOccurrence'
            : 'customRecurrence.firstOccurrence',
        { date: formatDate(savedDate) },
      )
    : null;

  // The overrides `futureOverrides` holds start at the stored due date, which
  // covers every one the server deletes unless the edit moves the due date
  // earlier (see `orphanedOverrideDates`).
  const orphans =
    stored && edited ? orphanedOverrideDates(edited, stored, scheduledTransaction?.futureOverrides ?? []) : [];
  const orphanWarning =
    orphans.length > 0
      ? t('customRecurrence.orphanWarning', {
          count: orphans.length,
          dates: formatList(orphans.map((d) => formatDate(d)), locale),
        })
      : null;

  return { frequencyOptions, onFrequencyChange, editorProps, occurrenceCaption, customRefusal, orphanWarning };
}
