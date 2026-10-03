'use client';

import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/Combobox';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import { Input } from '@/components/ui/Input';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useRuleEnumLabels } from '@/components/rules/use-rule-enum-labels';
import { useRuleErrorMessage } from '@/components/rules/use-rule-error-message';
import type { RuleOptions } from '@/components/rules/use-rule-options';
import { MAX_CAPTURES_PER_PATTERN } from '@/lib/rule-captures';
import {
  MAX_RULE_TEXT_LENGTH,
  RULE_CONDITION_FIELDS,
  RULE_MAX_DAY_OF_MONTH,
  RULE_MIN_DAY_OF_MONTH,
  RULE_OPERATOR_SHAPES,
  isEditorRuleField,
} from '@/lib/rule-fields';
import type { EditorLeaf, EditorValue } from '@/lib/rule-tree';

interface RuleValueControlProps {
  leaf: EditorLeaf;
  options: RuleOptions;
  onChange: (value: EditorValue) => void;
  /** Codes the leaf's `matches` pattern is refused with (`scanCaptures`), shown under the input. */
  captureCodes?: readonly string[];
}

/** What the pattern hint shows as its example; braces go in as values so the catalog needs no escaping. */
const CAPTURE_SYNTAX = '{name}';
const CAPTURE_EXAMPLE = '*Payee: {payee} Account*';

/** Whole days of the month, as the picker for `in` lists them. */
const DAY_OPTIONS = Array.from({ length: RULE_MAX_DAY_OF_MONTH - RULE_MIN_DAY_OF_MONTH + 1 }, (_, i) => {
  const day = String(RULE_MIN_DAY_OF_MONTH + i);
  return { value: day, label: day };
});

const asString = (v: EditorValue): string => (typeof v === 'string' ? v : '');
const asNumber = (v: EditorValue): number | undefined => (typeof v === 'number' ? v : undefined);
const asStrings = (v: EditorValue): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [];
const asDays = (v: EditorValue): string[] =>
  Array.isArray(v) ? (v as unknown[]).filter((x): x is number => typeof x === 'number').map(String) : [];
const asDateRange = (v: EditorValue): [string, string] => {
  const list = Array.isArray(v) ? (v as unknown[]) : [];
  return [typeof list[0] === 'string' ? list[0] : '', typeof list[1] === 'string' ? list[1] : ''];
};
const asRange = (v: EditorValue): [number | undefined, number | undefined] => {
  const list = Array.isArray(v) ? (v as (number | undefined)[]) : [];
  return [list[0], list[1]];
};

/** Codes already chosen stay selectable even when the user has since deactivated them. */
function withSelected(codes: readonly string[], selected: readonly string[]): string[] {
  return [...new Set([...codes, ...selected.filter((c) => c !== '')])].sort();
}

/**
 * The value control for one leaf: the picker the transaction form uses for
 * that kind of field, so a rule never shows an id. Which control it is follows
 * from the field's kind and the operator's shape (none, one, a list, a range).
 */
export function RuleValueControl({ leaf, options, onChange, captureCodes = [] }: RuleValueControlProps) {
  const t = useTranslations('rules.editor');
  const enumLabels = useRuleEnumLabels();
  const errorMessage = useRuleErrorMessage();
  const spec = RULE_CONDITION_FIELDS[leaf.field];
  const shape = RULE_OPERATOR_SHAPES[leaf.op];
  const id = `${leaf.uid}-value`;
  const label = t('condition.value');
  const value = leaf.value;

  if (shape === 'none') return null;

  // A field this client does not know: show the stored value as it is, never a wrong control.
  if (!isEditorRuleField(leaf.field)) {
    return (
      <div>
        <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
        <code className="block py-2 text-sm text-gray-700 dark:text-gray-300">{JSON.stringify(value ?? null)}</code>
      </div>
    );
  }

  switch (spec.kind) {
    case 'accountId':
    case 'payeeId':
    case 'categoryId': {
      const list =
        spec.kind === 'accountId' ? options.accounts : spec.kind === 'payeeId' ? options.payees : options.categories;
      if (shape === 'list') {
        const placeholder =
          spec.kind === 'accountId'
            ? t('value.accounts')
            : spec.kind === 'payeeId'
              ? t('value.payees')
              : t('value.categories');
        return (
          <MultiSelect label={label} options={list} value={asStrings(value)} onChange={onChange} placeholder={placeholder} />
        );
      }
      const placeholder =
        spec.kind === 'accountId' ? t('value.account') : spec.kind === 'payeeId' ? t('value.payee') : t('value.category');
      return (
        <Combobox
          label={label}
          placeholder={placeholder}
          options={list}
          value={asString(value)}
          onChange={(next) => onChange(next)}
          valueIsId
          usePortal
        />
      );
    }
    case 'tagIds':
      return (
        <MultiSelect
          label={label}
          options={options.tags}
          value={asStrings(value)}
          onChange={onChange}
          placeholder={t('value.tags')}
        />
      );
    case 'enum': {
      const enumOptions = enumLabels.options(leaf.field);
      if (shape === 'list') {
        return (
          <MultiSelect
            label={label}
            options={enumOptions}
            value={asStrings(value)}
            onChange={onChange}
            placeholder={t(leaf.field === 'weekday' ? 'value.weekdays' : leaf.field === 'status' ? 'value.statuses' : 'value.types')}
            showSearch={false}
          />
        );
      }
      return (
        <Select id={id} label={label} options={enumOptions} value={asString(value)} onChange={(e) => onChange(e.target.value)} />
      );
    }
    case 'dayOfMonth': {
      const dayProps = { decimalPlaces: 0, min: RULE_MIN_DAY_OF_MONTH, max: RULE_MAX_DAY_OF_MONTH } as const;
      if (shape === 'range') {
        const [min, max] = asRange(value);
        return (
          <div className="grid grid-cols-2 gap-2">
            <NumericInput id={`${id}-from`} label={t('value.from')} value={min} {...dayProps} onChange={(next) => onChange([next, max])} />
            <NumericInput id={`${id}-to`} label={t('value.to')} value={max} {...dayProps} onChange={(next) => onChange([min, next])} />
          </div>
        );
      }
      if (shape === 'list') {
        return (
          <MultiSelect
            label={label}
            options={DAY_OPTIONS}
            value={asDays(value)}
            onChange={(days) => onChange(days.map(Number).sort((a, b) => a - b))}
            placeholder={t('value.days')}
            showSearch={false}
          />
        );
      }
      return <NumericInput id={id} label={label} value={asNumber(value)} {...dayProps} onChange={onChange} />;
    }
    case 'date': {
      if (shape === 'range') {
        const [from, to] = asDateRange(value);
        return (
          <div className="grid grid-cols-2 gap-2">
            <DateInput id={`${id}-from`} label={t('value.from')} value={from} onDateChange={(next) => onChange([next, to])} />
            <DateInput id={`${id}-to`} label={t('value.to')} value={to} onDateChange={(next) => onChange([from, next])} />
          </div>
        );
      }
      return <DateInput id={id} label={label} value={asString(value)} onDateChange={onChange} />;
    }
    case 'currency': {
      const codes = withSelected(options.currencyCodes, shape === 'list' ? asStrings(value) : [asString(value)]);
      if (shape === 'list') {
        return (
          <MultiSelect
            label={label}
            options={codes.map((code) => ({ value: code, label: code }))}
            value={asStrings(value)}
            onChange={onChange}
            placeholder={t('value.currencies')}
          />
        );
      }
      return (
        <Select
          id={id}
          label={label}
          value={asString(value)}
          onChange={(e) => onChange(e.target.value)}
          options={[{ value: '', label: t('value.currency') }, ...codes.map((code) => ({ value: code, label: code }))]}
        />
      );
    }
    case 'money': {
      // The calculator lets a minus sign through, so an unsigned field goes without it.
      const allowNegative = leaf.field !== 'absAmount';
      if (shape === 'range') {
        const [min, max] = asRange(value);
        return (
          <div className="grid grid-cols-2 gap-2">
            <CurrencyInput
              id={`${id}-from`}
              label={t('value.from')}
              value={min}
              allowNegative={allowNegative}
              allowCalculator={allowNegative}
              onChange={(next) => onChange([next, max])}
            />
            <CurrencyInput
              id={`${id}-to`}
              label={t('value.to')}
              value={max}
              allowNegative={allowNegative}
              allowCalculator={allowNegative}
              onChange={(next) => onChange([min, next])}
            />
          </div>
        );
      }
      return (
        <CurrencyInput
          id={id}
          label={t('value.amount')}
          value={asNumber(value)}
          allowNegative={allowNegative}
          allowCalculator={allowNegative}
          onChange={onChange}
        />
      );
    }
    case 'boolean':
      return (
        <div>
          <span className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
          <div className="flex items-center gap-2 py-2">
            <ToggleSwitch checked={value === true} onChange={onChange} label={t(`fields.${leaf.field}`)} />
            <span className="text-sm text-gray-700 dark:text-gray-300">{value === true ? t('value.yes') : t('value.no')}</span>
          </div>
        </div>
      );
    default:
      return (
        <div>
          <Input
            id={id}
            label={label}
            value={asString(value)}
            maxLength={MAX_RULE_TEXT_LENGTH}
            error={leaf.op === 'matches' && captureCodes.length > 0 ? captureCodes.map(errorMessage).join(' ') : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {leaf.op === 'matches' && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('value.matchesHint', { capture: CAPTURE_SYNTAX, example: CAPTURE_EXAMPLE, max: MAX_CAPTURES_PER_PATTERN })}
            </p>
          )}
        </div>
      );
  }
}
