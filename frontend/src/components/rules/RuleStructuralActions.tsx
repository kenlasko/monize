'use client';

import { useTranslations } from 'next-intl';
import { RuleSwitchRow } from '@/components/rules/RuleSwitchRow';
import { useRuleErrorMessage } from '@/components/rules/use-rule-error-message';
import type { RuleOption, RuleOptions } from '@/components/rules/use-rule-options';
import { RemoveSplitLineButton } from '@/components/transactions/SplitLineButtons';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  SPLIT_REST,
  addSplitPart,
  canAddSplitPart,
  canRemoveSplitPart,
  captureAmount,
  captureOfAmount,
  removeSplitPart,
  restIsFree,
  updateSplitPart,
  type EditorAction,
  type EditorSplitPart,
  type SplitPartKind,
  type TransferDirection,
} from '@/lib/rule-actions';
import type { StructuralFieldErrors } from '@/lib/rule-errors';
import { MAX_RULE_SPLIT_DESCRIPTION_LENGTH, MAX_RULE_SPLIT_PARTS } from '@/lib/rule-fields';

type ConvertAction = Extract<EditorAction, { type: 'convert_to_transfer' }>;
type SplitEditorAction = Extract<EditorAction, { type: 'split' }>;

type FieldErrors = StructuralFieldErrors['fields'];

/** The sentence(s) for the codes at a field, or nothing. */
function useFieldError(fields: FieldErrors): (...paths: string[]) => string | undefined {
  const message = useRuleErrorMessage();
  return (...paths) => {
    const codes = [...new Set(paths.flatMap((path) => fields[path] ?? []))];
    return codes.length === 0 ? undefined : codes.map(message).join(' ');
  };
}

/**
 * The accounts a transfer may name: the transfer form's own list, plus an
 * account the rule already names that the list leaves out (a closed one), so
 * a stored choice never reads as a blank field.
 */
function accountChoices(options: RuleOptions, selected: readonly string[]): RuleOption[] {
  const extra = options.accounts.filter(
    (account) => selected.includes(account.value) && !options.transferAccounts.some((o) => o.value === account.value),
  );
  return [...options.transferAccounts, ...extra];
}

interface ConvertFieldsProps {
  action: ConvertAction;
  options: RuleOptions;
  onChange: (action: EditorAction) => void;
  fields: FieldErrors;
}

/**
 * `convert_to_transfer`: which way the money goes, the other account (the
 * transfer form's account picker), whether the category goes, and the payee of
 * both legs.
 */
export function ConvertToTransferFields({ action, options, onChange, fields }: ConvertFieldsProps) {
  const t = useTranslations('rules.editor.action');
  const tx = useTranslations('transactions.form');
  const fieldError = useFieldError(fields);
  const toSide = action.direction === 'to';

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('convertHelp')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          id={`${action.uid}-direction`}
          label={t('direction')}
          value={action.direction}
          options={[
            { value: 'to', label: t('directionTo') },
            { value: 'from', label: t('directionFrom') },
          ]}
          onChange={(e) => {
            if (e.target.value === 'to' || e.target.value === 'from') {
              onChange({ ...action, direction: e.target.value as TransferDirection });
            }
          }}
        />
        <Select
          id={`${action.uid}-account`}
          label={toSide ? tx('fields.toAccount') : tx('fields.fromAccount')}
          value={action.accountId}
          options={[
            { value: '', label: toSide ? tx('placeholders.selectDestinationAccount') : tx('placeholders.selectAccount') },
            ...accountChoices(options, [action.accountId]),
          ]}
          error={fieldError('toAccountId', 'fromAccountId')}
          onChange={(e) => onChange({ ...action, accountId: e.target.value })}
        />
      </div>
      <Combobox
        label={tx('fields.payeeOptional')}
        placeholder={tx('placeholders.selectOrTypePayee')}
        options={options.payees}
        value={action.payeeId}
        onChange={(payeeId) => onChange({ ...action, payeeId })}
        error={fieldError('payeeId')}
        valueIsId
        usePortal
      />
      <RuleSwitchRow
        checked={action.clearCategory}
        onChange={(clearCategory) => onChange({ ...action, clearCategory })}
        label={t('clearCategory')}
        help={t('clearCategoryHelp')}
      />
    </div>
  );
}

interface PartProps {
  part: EditorSplitPart;
  index: number;
  parts: readonly EditorSplitPart[];
  captures: readonly string[];
  options: RuleOptions;
  onChange: (part: EditorSplitPart) => void;
  onRemove: () => void;
  fields: FieldErrors;
}

/**
 * One part of a split, laid out like a `SplitEditor` line: the amount (here a
 * capture of the pattern or the rest, since a rule knows no number), whether it
 * is a category line or a transfer, the category or the account, the payee of
 * the other leg of a transfer, and a memo.
 */
function SplitPartRow({ part, index, parts, captures, options, onChange, onRemove, fields }: PartProps) {
  const t = useTranslations('rules.editor.action');
  const ts = useTranslations('transactions.splitEditor');
  const tx = useTranslations('transactions.form');
  const fieldError = useFieldError(fields);
  const at = `parts[${index}]`;
  const named = captureOfAmount(part.amount);
  // A capture the patterns no longer define stays listed, so the select does not show a blank.
  const captureNames = named !== null && !captures.includes(named) ? [...captures, named] : captures;
  const amountOptions = [
    { value: '', label: t('partAmountPlaceholder') },
    ...captureNames.map((name) => ({ value: captureAmount(name), label: captureAmount(name) })),
    ...(restIsFree(parts, index) || part.amount === SPLIT_REST ? [{ value: SPLIT_REST, label: t('partRest') }] : []),
  ];
  const partError = fieldError(at);

  return (
    <div
      role="group"
      aria-label={ts('splitLabel', { number: index + 1 })}
      className="space-y-2 rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{ts('splitLabel', { number: index + 1 })}</span>
        <RemoveSplitLineButton
          onClick={onRemove}
          disabled={!canRemoveSplitPart(parts)}
          title={canRemoveSplitPart(parts) ? ts('removeSplit') : ts('removeMinimum')}
        />
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Select
          id={`${part.uid}-amount`}
          label={ts('columns.amount')}
          value={part.amount}
          options={amountOptions}
          error={fieldError(`${at}.amount`)}
          onChange={(e) => onChange({ ...part, amount: e.target.value })}
        />
        <Select
          id={`${part.uid}-kind`}
          label={ts('columns.type')}
          value={part.kind}
          options={[
            { value: 'category', label: ts('splitTypes.category') },
            { value: 'transfer', label: ts('splitTypes.transfer') },
          ]}
          onChange={(e) => {
            const kind = e.target.value as SplitPartKind;
            if (kind === part.kind) return;
            // The other kind starts empty: a category and a transfer account never go together.
            onChange({ ...part, kind, categoryId: '', transferAccountId: '', payeeId: '' });
          }}
        />
      </div>
      {part.kind === 'category' ? (
        <Combobox
          label={ts('columns.category')}
          placeholder={ts('selectCategory')}
          options={options.categories}
          value={part.categoryId}
          onChange={(categoryId) => onChange({ ...part, categoryId })}
          error={fieldError(`${at}.categoryId`)}
          valueIsId
          usePortal
        />
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Select
            id={`${part.uid}-account`}
            label={t('partAccount')}
            value={part.transferAccountId}
            options={[{ value: '', label: ts('selectAccount') }, ...accountChoices(options, [part.transferAccountId])]}
            error={fieldError(`${at}.transferAccountId`)}
            onChange={(e) => onChange({ ...part, transferAccountId: e.target.value })}
          />
          <Combobox
            label={t('partPayee')}
            placeholder={tx('placeholders.selectOrTypePayee')}
            options={options.payees}
            value={part.payeeId}
            onChange={(payeeId) => onChange({ ...part, payeeId })}
            error={fieldError(`${at}.payeeId`)}
            valueIsId
            usePortal
          />
        </div>
      )}
      <Input
        id={`${part.uid}-description`}
        label={ts('columns.memo')}
        type="text"
        value={part.description}
        placeholder={ts('memoPlaceholder')}
        maxLength={MAX_RULE_SPLIT_DESCRIPTION_LENGTH}
        error={fieldError(`${at}.description`)}
        onChange={(e) => onChange({ ...part, description: e.target.value })}
      />
      {partError && <p className="text-sm text-red-600 dark:text-red-400">{partError}</p>}
    </div>
  );
}

interface SplitFieldsProps {
  action: SplitEditorAction;
  options: RuleOptions;
  /** The capture names the rule's patterns define: what a part's amount can be. */
  captures: readonly string[];
  onChange: (action: EditorAction) => void;
  fields: FieldErrors;
}

/**
 * `split`: the parent's payee and the list of parts. A rule has no amount to
 * balance against, so where `SplitEditor` shows what remains, this says that
 * the parts must add up to the transaction (a transaction whose parts do not is
 * left alone, with the reason in the test).
 */
export function SplitFields({ action, options, captures, onChange, fields }: SplitFieldsProps) {
  const t = useTranslations('rules.editor.action');
  const ts = useTranslations('transactions.splitEditor');
  const tx = useTranslations('transactions.form');
  const fieldError = useFieldError(fields);
  const setParts = (parts: readonly EditorSplitPart[]) => onChange({ ...action, parts });
  const listError = fieldError('parts');

  return (
    <div className="space-y-3">
      <Combobox
        label={t('splitPayee')}
        placeholder={tx('placeholders.selectOrTypePayee')}
        options={options.payees}
        value={action.payeeId}
        onChange={(payeeId) => onChange({ ...action, payeeId })}
        error={fieldError('payeeId')}
        valueIsId
        usePortal
      />
      <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
        <p>{t('splitHint')}</p>
        {captures.length === 0 && <p>{t('splitNoCaptures', { example: captureAmount('principal') })}</p>}
      </div>
      <div className="space-y-2">
        {action.parts.map((part, index) => (
          <SplitPartRow
            key={part.uid}
            part={part}
            index={index}
            parts={action.parts}
            captures={captures}
            options={options}
            fields={fields}
            onChange={(next) => setParts(updateSplitPart(action.parts, index, next))}
            onRemove={() => setParts(removeSplitPart(action.parts, index))}
          />
        ))}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canAddSplitPart(action.parts)}
        onClick={() => setParts(addSplitPart(action.parts))}
      >
        {ts('addSplit')}
      </Button>
      {!canAddSplitPart(action.parts) && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('partsLimit', { max: MAX_RULE_SPLIT_PARTS })}</p>
      )}
      {listError && <p className="text-sm text-red-600 dark:text-red-400">{listError}</p>}
    </div>
  );
}
