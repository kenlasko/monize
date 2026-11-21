'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { getCurrencySymbol } from '@/lib/format';
import { computePayoffScenario } from '@/lib/credit-card-payoff';
import { CARD_CLASS } from '@/components/ui/Card';

interface PayoffCalculatorProps {
  /** Amount owed as a positive magnitude. */
  balance: number;
  interestRate: number | null;
  currencyCode: string;
}

/** Parse a `YYYY-MM-DD` string into a local Date without timezone drift. */
function toLocalDate(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function defaultPayment(balance: number): number {
  return Math.max(25, Math.ceil((balance * 0.03) / 5) * 5);
}

/**
 * Carried-balance payoff simulator: given a fixed monthly payment, projects the
 * time to clear the balance, total interest, and payoff date using revolving
 * interest math (see `computePayoffScenario`).
 */
export function PayoffCalculator({ balance, interestRate, currencyCode }: PayoffCalculatorProps) {
  const t = useTranslations('accountDetail-creditCard');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  const owed = Math.max(0, balance);
  const [payment, setPayment] = useState<number | undefined>(() => defaultPayment(owed));
  const paymentValue = payment ?? 0;

  const scenario = useMemo(
    () => computePayoffScenario(owed, interestRate, paymentValue),
    [owed, interestRate, paymentValue],
  );

  if (owed <= 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('payoff.title')}
        </h2>
        <div className={`${CARD_CLASS} p-4`}>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t('payoff.noBalance')}</p>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('payoff.title')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('payoff.description')}</p>
      <div className={`${CARD_CLASS} p-4 space-y-4`}>
        <div className="w-48">
          <CurrencyInput
            id="payoff-monthly-payment"
            label={t('payoff.monthlyPayment')}
            prefix={getCurrencySymbol(currencyCode)}
            allowNegative={false}
            value={payment}
            onChange={setPayment}
          />
        </div>

        {scenario.neverPaysOff ? (
          <p className="text-sm text-red-600 dark:text-red-400">{t('payoff.neverPaysOff')}</p>
        ) : (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">{t('payoff.payoffTime')}</dt>
              <dd className="text-lg font-bold text-gray-900 dark:text-gray-100">
                {t('payoff.months', { count: scenario.payoffMonths ?? 0 })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">{t('payoff.totalInterest')}</dt>
              <dd className="text-lg font-bold text-orange-600 dark:text-orange-400">
                {formatCurrency(scenario.totalInterest, currencyCode)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500 dark:text-gray-400">{t('payoff.payoffDate')}</dt>
              <dd className="text-lg font-bold text-purple-600 dark:text-purple-400">
                {scenario.payoffDate ? formatDate(toLocalDate(scenario.payoffDate)) : '--'}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </section>
  );
}
