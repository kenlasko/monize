'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PlusIcon } from '@heroicons/react/24/outline';
import { moveRow, TradeRowButtons } from '@/components/email-receipts/TradeRowButtons';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { accountStanding, type ReceiptParserAccountOption } from '@/hooks/useReceiptParserLookups';
import {
  newTradeAccountRule,
  type ParserFormChange,
  type ParserFormState,
  type TradeAccountRuleRow,
} from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS } from '@/types/email-receipts';

type Translator = ReturnType<typeof useTranslations>;

/**
 * The account picker's options: the open brokerage accounts, each with its
 * currency (two accounts of one name are told apart by it), and the account the
 * row already holds when it is not one of them, flagged, so a stored id is
 * never shown as blank.
 */
export function tradeAccountOptions(
  accounts: readonly ReceiptParserAccountOption[],
  heldId: string,
  placeholder: string,
  t: Translator,
): { value: string; label: string }[] {
  const options = [
    { value: '', label: placeholder },
    ...accounts
      .filter((account) => account.tradable)
      .map((account) => ({ value: account.value, label: t('accountOption', { name: account.label, currency: account.currencyCode }) })),
  ];
  if (heldId === '' || options.some((option) => option.value === heldId)) return options;
  const held = accounts.find((account) => account.value === heldId);
  return [
    ...options,
    { value: heldId, label: held ? t('accountNotTradableOption', { name: held.label }) : t('accountUnknownOption') },
  ];
}

/** The currency picker's options: `anyLabel` first when the field may be any currency, then the codes, the base one marked. */
export function tradeCurrencyOptions(
  currencies: readonly string[],
  baseCurrency: string,
  first: { value: ''; label: string },
  t: Translator,
): { value: string; label: string }[] {
  return [
    first,
    ...currencies.map((code) => ({ value: code, label: code === baseCurrency ? t('baseCurrency', { code }) : code })),
  ];
}

interface TradeAccountRulesFieldsProps {
  form: ParserFormState;
  accounts: readonly ReceiptParserAccountOption[];
  /** The codes to offer, the base currency first (`tradeCurrencyChoices`). */
  currencies: readonly string[];
  baseCurrency: string;
  onChange: ParserFormChange;
}

/**
 * Which brokerage account a trade email is for: rules tried in order against
 * the account text the profile reads, each optionally limited to one currency,
 * then the default account. Two accounts the broker prints the same way (a CAD
 * and a USD RRSP, both "RRSP") are two rules with the same text and different
 * currencies. A rule with a currency never guesses: when the email's currency
 * cannot be told, the email waits for a person.
 */
export function TradeAccountRulesFields({ form, accounts, currencies, baseCurrency, onChange }: TradeAccountRulesFieldsProps) {
  const t = useTranslations('emailReceipts.editor.trade');
  const rules = form.tradeAccountRules;
  const atMax = rules.length >= RECEIPT_PARSER_LIMITS.maxTradeAccountRules;
  const currencyOptions = useMemo(
    () => tradeCurrencyOptions(currencies, baseCurrency, { value: '', label: t('anyCurrency') }, t),
    [currencies, baseCurrency, t],
  );

  const update = (id: string, changes: Partial<TradeAccountRuleRow>) =>
    onChange((current) => ({
      tradeAccountRules: current.tradeAccountRules.map((rule) => (rule.id === id ? { ...rule, ...changes } : rule)),
    }));
  const move = (id: string, by: -1 | 1) =>
    onChange((current) => ({
      tradeAccountRules: moveRow(current.tradeAccountRules, current.tradeAccountRules.findIndex((rule) => rule.id === id), by),
    }));
  const remove = (id: string) =>
    onChange((current) => ({ tradeAccountRules: current.tradeAccountRules.filter((rule) => rule.id !== id) }));
  const add = () =>
    onChange((current) =>
      current.tradeAccountRules.length >= RECEIPT_PARSER_LIMITS.maxTradeAccountRules
        ? {}
        : { tradeAccountRules: [...current.tradeAccountRules, newTradeAccountRule()] },
    );

  const standingNote = (accountId: string, key: string) => {
    if (accountId === '') return null;
    const standing = accountStanding(accounts, accountId);
    if (standing === 'tradable') return null;
    return (
      <p key={key} role="note" className="text-xs text-amber-700 dark:text-amber-300">
        {t(standing === 'unknown' ? 'accountUnknown' : 'accountNotTradable')}
      </p>
    );
  };

  return (
    <fieldset className="space-y-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('rulesHeading')}</legend>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('rulesHelp', { star: '*' })}</p>
      <p className="rounded-md bg-blue-50 p-2 text-xs text-blue-900 dark:bg-blue-900/20 dark:text-blue-100">
        {t('currencyOrder')}
      </p>

      {rules.length > 0 && (
        <ol className="space-y-3">
          {rules.map((rule, index) => {
            const number = index + 1;
            return (
              <li key={rule.id} className="space-y-1">
                {/* The currency column is as wide as its longest option, so
                    "CAD (your base currency)" shows whole in every language;
                    the pattern box gives up the room. */}
                <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(6rem,0.6fr)_max-content_minmax(0,1fr)_auto]">
                  <Input
                    id={`parser-trade-rule-${rule.id}-match`}
                    aria-label={t('ruleMatchLabel', { rule: number })}
                    placeholder={t('ruleMatchPlaceholder')}
                    value={rule.match}
                    maxLength={RECEIPT_PARSER_LIMITS.maxPatternLength}
                    spellCheck={false}
                    className="font-mono"
                    onChange={(e) => update(rule.id, { match: e.target.value })}
                  />
                  <Select
                    id={`parser-trade-rule-${rule.id}-currency`}
                    aria-label={t('ruleCurrencyLabel', { rule: number })}
                    value={rule.currency}
                    options={currencyOptions}
                    onChange={(e) => update(rule.id, { currency: e.target.value })}
                  />
                  <Select
                    id={`parser-trade-rule-${rule.id}-account`}
                    aria-label={t('ruleAccountLabel', { rule: number })}
                    value={rule.accountId}
                    options={tradeAccountOptions(accounts, rule.accountId, t('accountPlaceholder'), t)}
                    onChange={(e) => update(rule.id, { accountId: e.target.value })}
                  />
                  <TradeRowButtons
                    index={index}
                    count={rules.length}
                    labels={{
                      up: t('ruleMoveUp', { rule: number }),
                      down: t('ruleMoveDown', { rule: number }),
                      remove: t('ruleRemove', { rule: number }),
                    }}
                    onMove={(by) => move(rule.id, by)}
                    onRemove={() => remove(rule.id)}
                  />
                </div>
                {standingNote(rule.accountId, `${rule.id}-note`)}
              </li>
            );
          })}
        </ol>
      )}

      {rules.length > 0 && form.tradeAccount.trim() === '' && (
        <p role="note" className="text-xs text-amber-700 dark:text-amber-300">
          {t('rulesWithoutAccountText', { star: '*' })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={atMax} className="gap-1.5">
          <PlusIcon className="h-4 w-4" aria-hidden />
          {t('ruleAdd')}
        </Button>
        {atMax && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {t('rulesMax', { max: RECEIPT_PARSER_LIMITS.maxTradeAccountRules })}
          </span>
        )}
      </div>

      <div>
        <Select
          id="parser-trade-default-account"
          label={t('defaultAccountLabel')}
          value={form.tradeDefaultAccountId}
          options={tradeAccountOptions(accounts, form.tradeDefaultAccountId, t('defaultAccountNone'), t)}
          onChange={(e) => onChange({ tradeDefaultAccountId: e.target.value })}
        />
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('defaultAccountHint')}</p>
        {standingNote(form.tradeDefaultAccountId, 'default-note')}
      </div>
    </fieldset>
  );
}
