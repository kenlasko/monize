'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';
import { CategoryPickerIcon } from '@/components/categories/CategoryPickerIcon';
import { payeeOptionIcon } from '@/components/payees/withPayeeIcons';
import { Combobox } from '@/components/ui/Combobox';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useAccountOptionLabel } from '@/hooks/useMainAccountName';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { buildCategoryPickerOptions } from '@/lib/categoryUtils';
import { entryDecimalPlaces, getCurrencySymbol } from '@/lib/format';
import type { Account } from '@/types/account';
import type { Category } from '@/types/category';
import type { Payee } from '@/types/payee';
import {
  QUICK_ADD_KINDS,
  type QuickAddInterpretation,
  type QuickAddKind,
  type QuickAddPins,
} from '@/types/quick-add';
import type { QuickAddChipField } from './quick-add-chips';

/**
 * The accounts the full form offers for a cash entry: the reader's own, open,
 * not a brokerage and not a shared-expense settlement account.
 */
export function quickAddEligibleAccounts(accounts: readonly Account[]): Account[] {
  return accounts.filter(
    (account) =>
      !account.isJoint &&
      !account.isClosed &&
      !account.managedPurpose &&
      account.accountSubType !== 'INVESTMENT_BROKERAGE',
  );
}

/** Pin what the reader set; `done` closes the editor after a single pick. */
export type QuickAddOnPin = (patch: Partial<QuickAddPins>, done: boolean) => void;

export interface QuickAddFieldControlProps {
  id: string;
  field: QuickAddChipField;
  fieldLabel: string;
  reading: QuickAddInterpretation;
  accounts: Account[];
  payees: Payee[];
  categories: Category[];
  onPin: QuickAddOnPin;
}

/**
 * The control New Transaction uses for one field: the segmented control for
 * the kind, `CurrencyInput`, `DateInput`, the account select, the payee
 * combobox and the category picker.
 */
export function QuickAddFieldControl({
  id,
  field,
  fieldLabel,
  reading,
  accounts,
  payees,
  categories,
  onPin,
}: QuickAddFieldControlProps): ReactNode {
  switch (field) {
    case 'kind':
      return <KindControl current={reading.kind.value} onPin={onPin} />;
    case 'amount':
      return <AmountControl id={id} label={fieldLabel} reading={reading} onPin={onPin} />;
    case 'date':
      return (
        <DateInput
          id={id}
          label={fieldLabel}
          value={reading.date.value ?? ''}
          onDateChange={(date) => {
            if (date && date !== reading.date.value) onPin({ date }, false);
          }}
        />
      );
    case 'account':
    case 'toAccount':
      return (
        <AccountControl
          id={id}
          label={fieldLabel}
          field={field}
          reading={reading}
          accounts={accounts}
          onPin={onPin}
        />
      );
    case 'payee':
      return <PayeeControl label={fieldLabel} reading={reading} payees={payees} onPin={onPin} />;
    case 'category':
      return (
        <CategoryControl label={fieldLabel} reading={reading} categories={categories} onPin={onPin} />
      );
  }
}

/** The kind as the segmented control: one of the three, pressed. The editor names the group. */
function KindControl({ current, onPin }: { current: QuickAddKind | null; onPin: QuickAddOnPin }) {
  const t = useTranslations('transactions');
  return (
    <div className={SEGMENTED_GROUP_CLASS}>
      {QUICK_ADD_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          aria-pressed={kind === current}
          onClick={() => onPin({ kind }, true)}
          className={`${segmentClass(kind === current)} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
        >
          {t(`quickAdd.kinds.${kind}`)}
        </button>
      ))}
    </div>
  );
}

/** What the reader typed into the amount editor, and over which reading. */
interface AmountEdit {
  /** The reading's figure the edit was made over. */
  over: number | null;
  value: number | undefined;
}

/**
 * The amount at the account currency's places. Applied when the field is left
 * or Enter is pressed: `CurrencyInput` reports every keystroke, and a pin is
 * asked about at once, so pinning each prefix of the number would ask the
 * server once a key. Enter on a calculator expression only evaluates it.
 *
 * Until the reader types here the field shows the reading's figure, and
 * follows it while the editor stays open (the line retyped beneath it), so
 * leaving the field untouched pins nothing, least of all an earlier figure. A
 * figure typed in another currency is not an amount in the account's, so the
 * field starts empty for one.
 */
function AmountControl({
  id,
  label,
  reading,
  onPin,
}: {
  id: string;
  label: string;
  reading: QuickAddInterpretation;
  onPin: QuickAddOnPin;
}) {
  const { defaultCurrency } = useNumberFormat();
  const currency = reading.account.value?.currencyCode ?? defaultCurrency;
  const readAmount = reading.foreignAmount ? null : reading.amount.value;
  const [typed, setTyped] = useState<AmountEdit | null>(null);
  // A new reading replaces what was typed over the previous one; reset during
  // render (the "info from previous render" pattern), not in an effect.
  if (typed !== null && typed.over !== readAmount) setTyped(null);
  // Read by the blur and Enter that may follow a change before it renders.
  const edit = useRef<AmountEdit | null>(null);
  const apply = () => {
    const current = edit.current;
    // Nothing typed over the reading on screen: nothing to pin.
    if (current === null || current.over !== readAmount) return;
    const next = current.value;
    if (next !== undefined && next > 0 && next !== readAmount) {
      onPin({ amount: next }, false);
    }
  };
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.defaultPrevented) apply();
      }}
    >
      <CurrencyInput
        id={id}
        label={label}
        prefix={getCurrencySymbol(currency)}
        decimalPlaces={entryDecimalPlaces(currency)}
        value={typed !== null && typed.over === readAmount ? typed.value : (readAmount ?? undefined)}
        allowNegative={false}
        onChange={(next) => {
          const change = { over: readAmount, value: next };
          edit.current = change;
          setTyped(change);
        }}
        onBlur={apply}
      />
    </div>
  );
}

function AccountControl({
  id,
  label,
  field,
  reading,
  accounts,
  onPin,
}: {
  id: string;
  label: string;
  field: 'account' | 'toAccount';
  reading: QuickAddInterpretation;
  accounts: Account[];
  onPin: QuickAddOnPin;
}) {
  const t = useTranslations('transactions');
  const accountOptionLabel = useAccountOptionLabel();
  const current = reading[field].value?.id ?? '';
  // The other side of a transfer is not offered as this one.
  const otherSide = field === 'toAccount' ? reading.account.value?.id : reading.toAccount.value?.id;
  const options = [
    { value: '', label: t('form.placeholders.selectAccount') },
    ...buildAccountDropdownOptions(
      quickAddEligibleAccounts(accounts),
      (account) => account.id !== otherSide || account.id === current,
      accountOptionLabel,
    ),
  ];
  return (
    <AccountSelect
      id={id}
      label={label}
      value={current}
      options={options}
      onChange={(event) => {
        const accountId = event.target.value;
        if (!accountId || accountId === current) return;
        onPin(field === 'account' ? { accountId } : { toAccountId: accountId }, true);
      }}
    />
  );
}

/**
 * The payee combobox; a name no payee has is a payee the save creates first.
 * Clearing it is the reader's choice of no payee.
 */
function PayeeControl({
  label,
  reading,
  payees,
  onPin,
}: {
  label: string;
  reading: QuickAddInterpretation;
  payees: Payee[];
  onPin: QuickAddOnPin;
}) {
  const t = useTranslations('transactions');
  const payee = reading.payee.value;
  const options = useMemo(
    () =>
      payees
        .filter((p) => p.isActive !== false)
        .map((p) => ({
          value: p.id,
          label: p.name,
          icon: payeeOptionIcon(p),
          subtitle: p.defaultCategory?.name,
        })),
    [payees],
  );
  // The reading's other candidates first, as the editor's buttons list them.
  const priorityValues = reading.payee.alternatives
    .map((alternative) => alternative.id)
    .filter((value): value is string => !!value);
  return (
    <Combobox
      label={label}
      placeholder={t('form.placeholders.selectOrTypePayee')}
      options={options}
      value={payee?.id ?? ''}
      initialDisplayValue={payee?.name ?? ''}
      priorityValues={priorityValues}
      onChange={(payeeId, name) => {
        if (payeeId) onPin({ payeeId, payeeName: undefined }, true);
        else if (name.trim()) onPin({ payeeId: undefined, payeeName: name.trim() }, true);
        // Cleared: no payee, and none guessed in its place.
        else onPin({ payeeId: undefined, payeeName: undefined, clear: ['payee'] }, false);
      }}
      allowCustomValue
      valueIsId
      usePortal
    />
  );
}

/**
 * Every category in tree order as "Parent: Child", as the full form lists
 * them. Clearing it is the reader's choice of no category.
 */
function CategoryControl({
  label,
  reading,
  categories,
  onPin,
}: {
  label: string;
  reading: QuickAddInterpretation;
  categories: Category[];
  onPin: QuickAddOnPin;
}) {
  const t = useTranslations('transactions');
  const category = reading.category.value;
  // The category chip is an ordinary row's (a transfer shows a to-account
  // instead): Income or Expense only (INV-CATEGORY-001).
  const options = useMemo(
    () =>
      buildCategoryPickerOptions(categories, 'category', (c, label) => ({
        value: c.id,
        label,
        icon: <CategoryPickerIcon category={c} />,
      })),
    [categories],
  );
  return (
    <Combobox
      label={label}
      placeholder={t('quickAdd.editor.categoryPlaceholder')}
      options={options}
      value={category?.id ?? ''}
      initialDisplayValue={category?.name ?? ''}
      priorityValues={reading.category.alternatives.map((alternative) => alternative.id)}
      onChange={(categoryId) => {
        if (categoryId) onPin({ categoryId }, true);
        // Cleared: no category, and none guessed in its place.
        else onPin({ categoryId: undefined, clear: ['category'] }, false);
      }}
      valueIsId
      usePortal
    />
  );
}
