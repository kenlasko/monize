'use client';

import { useTranslations } from 'next-intl';
import {
  ArrowTrendingUpIcon,
  BanknotesIcon,
  ChartPieIcon,
  CircleStackIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import {
  SummaryCardGrid,
  type SummaryCardItem,
} from '@/components/accounts/shared/SummaryCardGrid';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { gainLossColor, withCurrencyCode } from '@/lib/format';
import type { SecurityDetail } from '@/types/investment';

interface SecuritySummaryCardsProps {
  detail: SecurityDetail;
  /**
   * Opens the Investments page filtered to one account. Optional: the cards
   * render read-only without it.
   */
  onSelectAccount?: (accountId: string) => void;
}

const ICON_CLASS = 'h-4 w-4';

/**
 * The five key figures, all in the security's own currency -- the currency its
 * price and average cost are quoted in, and the only one they add up in without
 * a conversion this page has no business making.
 *
 * A figure the portfolio could not compute is reported as unknown rather than as
 * zero: a zero market value is a claim about worth, and "there is no quote" (or
 * "this sits in a closed account") is not that claim.
 */
export function SecuritySummaryCards({
  detail,
  onSelectAccount,
}: SecuritySummaryCardsProps) {
  const t = useTranslations('securityDetail');
  const {
    formatCurrency,
    formatCurrencyPrecise,
    formatQuantity,
    formatPercent,
    formatSignedPercent,
    defaultCurrency,
  } = useNumberFormat();

  const { convertToDefault, getRate } = useExchangeRates();

  const { position, security } = detail;
  const currency = security.currencyCode;
  const isForeign = !!currency && currency !== defaultCurrency;

  /** The figure itself, in the security's own currency, named when foreign. */
  const money = (amount: number) =>
    withCurrencyCode(formatCurrency(amount, currency), currency, defaultCurrency);

  /**
   * The same figure in the reader's own currency, as a second line.
   *
   * At today's rate, which is why it is marked as approximate: for the market
   * value that is exactly right, but a cost basis converted today is not what
   * was paid -- the historical-rate figure for that lives in the Accounts table.
   * All three cards convert at the same rate, so the arithmetic between them
   * still holds.
   */
  // `convertToDefault` now returns null for a pair it has no rate for, so this
  // guard is belt-and-braces rather than the only thing standing between the
  // reader and a euro figure under a zloty symbol.
  const hasRate = isForeign && getRate(currency, defaultCurrency) !== null;

  const converted = (amount: number | null) => {
    if (!hasRate || amount === null) return undefined;
    const value = convertToDefault(amount, currency);
    if (value === null || !isFinite(value)) return undefined;
    return t('cards.approx', {
      amount: formatCurrency(value, defaultCurrency),
    });
  };
  const unknown = (
    <span className="text-gray-500 dark:text-gray-400">
      {t('cards.valueUnknown')}
    </span>
  );

  /** A signed money figure, so colour is never the only signal of a loss. */
  const signedMoney = (amount: number) =>
    `${amount >= 0 ? '+' : ''}${withCurrencyCode(
      formatCurrency(amount, currency),
      currency,
      defaultCurrency,
    )}`;

  const totalUnits = position.quantity;

  const cards: SummaryCardItem[] = [
    {
      label: t('cards.marketValue'),
      icon: <ChartPieIcon className={ICON_CLASS} />,
      value:
        position.marketValue === null
          ? unknown
          : money(position.marketValue),
      // No "as of" line here. It read "At the close of {date}", which is a
      // claim the price cannot support intraday: the newest row is that day's
      // last quote, not its close, and calling it one misdates every valuation
      // struck while the market is open. The header states when the price is
      // from, to the minute, and that is the one place to read it.
      note: converted(position.marketValue),
    },
    {
      label: t('cards.costBasis'),
      icon: <BanknotesIcon className={ICON_CLASS} />,
      value:
        position.costBasis === null
          ? unknown
          : money(position.costBasis),
      note: converted(position.costBasis),
    },
    {
      label: t('cards.unrealizedPl'),
      icon: <ArrowTrendingUpIcon className={ICON_CLASS} />,
      value:
        position.gainLoss === null ? (
          unknown
        ) : (
          <span
            className="ui-gain"
            data-sign={position.gainLoss === 0 ? undefined : position.gainLoss > 0 ? 'up' : 'down'}
          >
            {signedMoney(position.gainLoss)}
          </span>
        ),
      valueClass:
        position.gainLoss === null
          ? undefined
          : gainLossColor(position.gainLoss),
      note: (
        <>
          {position.gainLossPercent !== null && (
            <div
              className={`ui-gain ${gainLossColor(position.gainLossPercent)}`}
              data-sign={position.gainLossPercent === 0 ? undefined : position.gainLossPercent > 0 ? 'up' : 'down'}
            >
              {formatSignedPercent(position.gainLossPercent)}
            </div>
          )}
          {converted(position.gainLoss) && (
            <div>{converted(position.gainLoss)}</div>
          )}
        </>
      ),
    },
    {
      label: t('cards.units'),
      icon: <CircleStackIcon className={ICON_CLASS} />,
      value: formatQuantity(totalUnits),
      note: (
        <>
          <div>{t('cards.avgCostPerUnit')}</div>
          <div>
            {position.averageCost === null
              ? t('cards.valueUnknown')
              : withCurrencyCode(
                  formatCurrencyPrecise(position.averageCost, currency),
                  currency,
                  defaultCurrency,
                )}
          </div>
        </>
      ),
    },
    {
      label: t('cards.heldInAccounts'),
      icon: <UserGroupIcon className={ICON_CLASS} />,
      // Two units of information per row, so this card carries a small list
      // instead of the single figure the others show.
      className: 'sm:col-span-2',
      value: null,
      body: (
        <div className="mt-1">
          {detail.accounts.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('empty.noAccounts')}
            </p>
          ) : (
            <>
              {/* Bounded and scrolling past a handful of accounts, so a security
                  spread over ten of them leaves this card the same height as one
                  held in a single account -- it sits in a row with five others,
                  and growing it drags the whole grid down. `scrollbar-slim`
                  keeps the bar quiet; the native one is what looked broken. */}
              <ul className="scrollbar-slim max-h-28 space-y-0.5 overflow-y-auto pr-1">
                {detail.accounts.map((account) => {
                  const name = account.isClosed
                    ? t('accounts.closedSuffix', { name: account.accountName })
                    : account.accountName;
                  const units = t('cards.unitsShare', {
                    units: formatQuantity(account.quantity),
                    // A share of the total, not a gain: no leading sign.
                    share: formatPercent(
                      totalUnits === 0
                        ? 0
                        : (account.quantity / totalUnits) * 100,
                    ),
                  });
                  return (
                    <li key={account.accountId}>
                      {/* A closed account has nothing to show on the
                          Investments page, which lists open ones, so only an
                          open account is a link. */}
                      {onSelectAccount && !account.isClosed ? (
                        <button
                          type="button"
                          onClick={() => onSelectAccount(account.accountId)}
                          className="flex w-full items-baseline justify-between gap-3 rounded text-left text-sm hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-700/50"
                        >
                          {/* A phone wraps the name; from `sm` it is cut to one
                              line and carries its full text in `title`. */}
                          <span
                            className="min-w-0 break-words text-gray-900 hover:text-blue-600 sm:truncate dark:text-gray-100 dark:hover:text-blue-400"
                            title={name}
                          >
                            {name}
                          </span>
                          <span className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                            {units}
                          </span>
                        </button>
                      ) : (
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span
                            title={name}
                            className={`min-w-0 break-words sm:truncate ${
                              account.isClosed
                                ? 'text-gray-500 dark:text-gray-400'
                                : 'text-gray-900 dark:text-gray-100'
                            }`}
                          >
                            {name}
                          </span>
                          <span className="shrink-0 tabular-nums text-gray-900 dark:text-gray-100">
                            {units}
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <SummaryCardGrid
      cards={cards}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
    />
  );
}
