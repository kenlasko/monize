'use client';

import { useTranslations } from 'next-intl';
import { useFieldError } from '@/components/rules/RuleStructuralActions';
import type { RuleOption, RuleOptions } from '@/components/rules/use-rule-options';
import { Combobox } from '@/components/ui/Combobox';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { isExcessPolicy, isShortfallPolicy, type EditorAction } from '@/lib/rule-actions';
import type { StructuralFieldErrors } from '@/lib/rule-errors';
import {
  LOAN_SETTLEMENT_EXCESS_POLICIES,
  LOAN_SETTLEMENT_SHORTFALL_POLICIES,
  MAX_LOAN_SETTLEMENT_WINDOW_DAYS,
} from '@/lib/rule-fields';
import { IconSelect } from '@/components/ui/IconSelect';

type SettleLoanAction = Extract<EditorAction, { type: 'settle_loan_installment' }>;

/**
 * The loans a settlement may name: the open mortgages and loans, plus an
 * account the rule already names that the list leaves out (a closed one), so
 * a stored choice never reads as a blank field.
 */
function loanChoices(options: RuleOptions, selected: string): RuleOption[] {
  const extra = options.accounts.filter(
    (account) => account.value === selected && !options.loanAccounts.some((o) => o.value === selected),
  );
  return [...options.loanAccounts, ...extra];
}

interface RuleLoanSettlementFieldsProps {
  action: SettleLoanAction;
  options: RuleOptions;
  onChange: (action: EditorAction) => void;
  fields: StructuralFieldErrors['fields'];
}

/**
 * `settle_loan_installment`: the loan the debit pays, how far from a due date
 * the debit may fall, what an overpayment and an underpayment become, and the
 * interest line's category. The amounts are never typed: the server prices
 * each installment for the date it pays.
 */
export function RuleLoanSettlementFields({ action, options, onChange, fields }: RuleLoanSettlementFieldsProps) {
  const t = useTranslations('rules.editor.action.loan');
  const fieldError = useFieldError(fields);
  const days = (key: 'daysBefore' | 'daysAfter') => (value: number | undefined) =>
    onChange({ ...action, [key]: value === undefined ? null : value });

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('help')}</p>
      <IconSelect
        id={`${action.uid}-loan-account`}
        label={t('account')}
        value={action.loanAccountId}
        options={[{ value: '', label: t('accountPlaceholder') }, ...loanChoices(options, action.loanAccountId)]}
        error={fieldError('loanAccountId')}
        onChange={(e) => onChange({ ...action, loanAccountId: e.target.value })}
      />
      {options.loanAccounts.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{t('noLoans')}</p>
      )}
      <div>
        <div className="mb-1 flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300">
          <span>{t('window')}</span>
          <InfoTooltip text={t('windowHelp')} placement="top" usePortal />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumericInput
            id={`${action.uid}-days-before`}
            label={t('daysBefore')}
            decimalPlaces={0}
            min={0}
            max={MAX_LOAN_SETTLEMENT_WINDOW_DAYS}
            value={action.daysBefore ?? undefined}
            error={fieldError('dueDateWindow', 'dueDateWindow.daysBefore')}
            onChange={days('daysBefore')}
          />
          <NumericInput
            id={`${action.uid}-days-after`}
            label={t('daysAfter')}
            decimalPlaces={0}
            min={0}
            max={MAX_LOAN_SETTLEMENT_WINDOW_DAYS}
            value={action.daysAfter ?? undefined}
            error={fieldError('dueDateWindow.daysAfter')}
            onChange={days('daysAfter')}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Select
          id={`${action.uid}-excess`}
          label={t('excess')}
          value={action.excess}
          options={LOAN_SETTLEMENT_EXCESS_POLICIES.map((policy) => ({ value: policy, label: t(`excessPolicies.${policy}`) }))}
          error={fieldError('excess')}
          onChange={(e) => {
            if (isExcessPolicy(e.target.value)) onChange({ ...action, excess: e.target.value });
          }}
        />
        <Select
          id={`${action.uid}-shortfall`}
          label={t('shortfall')}
          value={action.shortfall}
          options={LOAN_SETTLEMENT_SHORTFALL_POLICIES.map((policy) => ({
            value: policy,
            label: t(`shortfallPolicies.${policy}`),
          }))}
          error={fieldError('shortfall')}
          onChange={(e) => {
            if (isShortfallPolicy(e.target.value)) onChange({ ...action, shortfall: e.target.value });
          }}
        />
      </div>
      <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
        <span>{t('policyNote')}</span>
        <InfoTooltip text={t('policyHelp')} placement="top" usePortal />
      </div>
      <Combobox
        label={t('interestCategory')}
        placeholder={t('interestCategoryPlaceholder')}
        options={options.categories}
        value={action.interestCategoryId}
        onChange={(interestCategoryId) => onChange({ ...action, interestCategoryId })}
        error={fieldError('interestCategoryId')}
        valueIsId
        usePortal
      />
    </div>
  );
}
