'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Input } from '@/components/ui/Input';
import type { ReceiptParserOption } from '@/hooks/useReceiptParserLookups';
import {
  blankCategoryRule,
  type CategoryRuleRow,
  type ParserFormChange,
  type ParserFormState,
} from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS } from '@/types/email-receipts';

interface ParserCategoryFieldsProps {
  form: ParserFormState;
  categories: readonly ReceiptParserOption[];
  onChange: ParserFormChange;
}

/**
 * Which category each line item gets: rules in order (the first whose pattern
 * matches the item's name wins), then a default, plus one for the shipping
 * line. A category is picked with the same combobox the transaction form uses,
 * so a rule never shows an id.
 */
export function ParserCategoryFields({ form, categories, onChange }: ParserCategoryFieldsProps) {
  const t = useTranslations('emailReceipts.editor.categories');
  const options = [...categories];

  const updateRule = (uid: string, changes: Partial<CategoryRuleRow>) =>
    onChange((current) => ({
      categoryRules: current.categoryRules.map((row) => (row.uid === uid ? { ...row, ...changes } : row)),
    }));

  const removeRule = (uid: string) =>
    onChange((current) => ({ categoryRules: current.categoryRules.filter((row) => row.uid !== uid) }));

  const addRule = () =>
    onChange((current) =>
      current.categoryRules.length >= RECEIPT_PARSER_LIMITS.maxCategoryRules
        ? {}
        : { categoryRules: [...current.categoryRules, blankCategoryRule()] },
    );

  const atLimit = form.categoryRules.length >= RECEIPT_PARSER_LIMITS.maxCategoryRules;

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('rulesHeading')}</h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          {t('rulesHelp', { max: RECEIPT_PARSER_LIMITS.maxCategoryRules, example: '*cable*' })}
        </p>
      </div>

      {form.categoryRules.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('noRules')}</p>
      )}

      <ul className="space-y-3">
        {form.categoryRules.map((row, index) => (
          <li key={row.uid} className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              id={`parser-rule-${row.uid}-match`}
              label={t('rulePatternLabel', { number: index + 1 })}
              value={row.match}
              maxLength={RECEIPT_PARSER_LIMITS.maxPatternLength}
              onChange={(e) => updateRule(row.uid, { match: e.target.value })}
            />
            <Combobox
              label={t('ruleCategoryLabel', { number: index + 1 })}
              aria-label={t('ruleCategoryLabel', { number: index + 1 })}
              placeholder={t('categoryPlaceholder')}
              options={options}
              value={row.categoryId}
              onChange={(value) => updateRule(row.uid, { categoryId: value })}
              valueIsId
              usePortal
              openOnFocus={false}
            />
            <Button type="button" variant="outline" size="sm" onClick={() => removeRule(row.uid)}>
              {t('removeRule', { number: index + 1 })}
            </Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={atLimit}
          onClick={addRule}
        >
          {t('addRule')}
        </Button>
        {atLimit && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('ruleLimit', { max: RECEIPT_PARSER_LIMITS.maxCategoryRules })}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Combobox
            label={t('defaultLabel')}
            aria-label={t('defaultLabel')}
            placeholder={t('categoryPlaceholder')}
            options={options}
            value={form.defaultCategoryId}
            onChange={(value) => onChange({ defaultCategoryId: value })}
            valueIsId
            usePortal
            openOnFocus={false}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('defaultHelp')}</p>
        </div>
        <div>
          <Combobox
            label={t('shippingLabel')}
            aria-label={t('shippingLabel')}
            placeholder={t('categoryPlaceholder')}
            options={options}
            value={form.shippingCategoryId}
            onChange={(value) => onChange({ shippingCategoryId: value })}
            valueIsId
            usePortal
            openOnFocus={false}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('shippingHelp')}</p>
        </div>
      </div>
    </div>
  );
}
