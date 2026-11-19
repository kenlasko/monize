'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { CsvTransferRule } from '@/lib/import';
import { Account } from '@/types/account';
import { accountSelectOption, orderAccountsForPicker, type AccountSelectOption } from '@/lib/account-utils';
import { SEPARATOR_VALUE } from '@/components/ui/IconSelect';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';

interface CsvTransferRulesProps {
  rules: CsvTransferRule[];
  onChange: (rules: CsvTransferRule[]) => void;
  accounts: Account[];
}

export function CsvTransferRules({ rules, onChange, accounts }: CsvTransferRulesProps) {
  const t = useTranslations('import');
  const filtered = accounts.filter(
    (a) => !a.isClosed && a.accountSubType !== 'INVESTMENT_BROKERAGE',
  );
  // The account-picker order, written once: favourites in the user's own
  // arrangement (alphabetically where it does not separate them), then the rest
  // by name. This block was a hand-copied version of exactly that.
  const { favourites: favouriteAccounts, rest: nonFavouriteAccounts } =
    orderAccountsForPicker(filtered);
  // A rule names its account by NAME (the CSV carries names), so each row's
  // value is the name; the mark is still the account's own.
  const toOption = (account: Account) => ({ ...accountSelectOption(account, account.name), value: account.name });
  const accountNameOptions: AccountSelectOption[] = [
    { value: '', label: t('transferRules.selectAccount') },
    ...favouriteAccounts.map(toOption),
    ...(favouriteAccounts.length > 0 && nonFavouriteAccounts.length > 0
      ? [{ value: SEPARATOR_VALUE, label: '', disabled: true }]
      : []),
    ...nonFavouriteAccounts.map(toOption),
  ];

  const addRule = () => {
    onChange([...rules, { type: 'payee', pattern: '', accountName: '' }]);
  };

  const removeRule = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, field: keyof CsvTransferRule, value: string) => {
    onChange(rules.map((r, i) => i === index ? { ...r, [field]: value } : r));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('transferRules.title')}
        </h4>
        <Button variant="outline" size="sm" onClick={addRule}>
          {t('transferRules.addRule')}
        </Button>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {t('transferRules.description')}
      </p>
      {rules.length === 0 && (
        <p className="text-sm text-gray-400 dark:text-gray-500 italic">
          {t('transferRules.noRules')}
        </p>
      )}
      {rules.map((rule, index) => (
        <div key={index} className="flex flex-col md:flex-row md:items-center gap-2 bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <select
              value={rule.type}
              onChange={(e) => updateRule(index, 'type', e.target.value)}
              className="flex-1 md:flex-initial md:w-[130px] px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            >
              <option value="payee">{t('transferRules.typePayee')}</option>
              <option value="category">{t('transferRules.typeCategory')}</option>
            </select>
            <button
              onClick={() => removeRule(index)}
              className="md:hidden text-red-500 hover:text-red-700 text-sm px-1"
              title={t('transferRules.removeTitle')}
            >
              {t('transferRules.remove')}
            </button>
          </div>
          <div className="flex items-center gap-2 md:flex-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">{t('transferRules.contains')}</span>
            <input
              type="text"
              value={rule.pattern}
              onChange={(e) => updateRule(index, 'pattern', e.target.value)}
              placeholder={t('transferRules.patternPlaceholder')}
              className="flex-1 min-w-0 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
            />
          </div>
          <div className="flex items-center gap-2 md:flex-1">
            <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{t('transferRules.asTransferFromTo')}</span>
            <div className="flex-1 min-w-0">
              <AccountSelect
                aria-label={t('transferRules.selectAccount')}
                value={rule.accountName}
                onChange={(e) => updateRule(index, 'accountName', e.target.value)}
                className="px-2 py-1.5 text-sm"
                options={accountNameOptions}
              />
            </div>
            <button
              onClick={() => removeRule(index)}
              className="hidden md:inline-flex text-red-500 hover:text-red-700 text-sm px-1"
              title={t('transferRules.removeTitle')}
            >
              X
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
