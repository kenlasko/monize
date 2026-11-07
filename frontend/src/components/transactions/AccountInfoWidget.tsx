'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  PencilSquareIcon,
  ChevronDoubleLeftIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { Account } from '@/types/account';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  formatAccountType,
  maskAccountNumber,
  orderAccountsForPicker,
} from '@/lib/account-utils';
import { getOrdinal } from '@/lib/ordinal';
import { balanceColor } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useLoanProjection } from '@/hooks/useLoanProjection';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { EntitySwitcher, type EntitySwitcherItem } from '@/components/ui/EntitySwitcher';
import { toSafeExternalUrl } from '@/lib/external-url';
import { getNextScheduled } from '@/lib/scheduled-utils';
import { UnknownAmount } from '@/components/ui/UnknownAmount';

interface AccountInfoWidgetProps {
  account: Account;
  /** Live balance derived from the same daily-balance series the Balance
   *  History chart summarises ("Current"), so the widget stays in sync as
   *  transactions change. Falls back to `account.currentBalance` when the
   *  series is unavailable (e.g. category/payee filters active). */
  currentBalance?: number;
  /** The account's institution, when assigned, for the logo + name. The
   *  optional website makes the logo a link to the institution's site. */
  institution?: (InstitutionLogoData & { website?: string }) | null;
  /** Scheduled bills/deposits; the soonest for this account is surfaced. */
  scheduledTransactions?: ScheduledTransaction[];
  /** Bumped by the page on every reload so the loan projection refetches in lockstep. */
  refreshKey?: number;
  /**
   * The accounts the Accounts filter currently offers -- already narrowed by
   * the Show Accounts (All/Active/Closed) toggle -- so the caret beside the
   * name switches only to an account the filter itself could select. Omit to
   * hide the caret.
   */
  switchableAccounts?: readonly Account[];
  /** Narrow the list to the chosen account, leaving every other filter as is. */
  onSwitchAccount?: (accountId: string) => void;
  /** Open the shared account edit modal for this account. */
  onEdit: () => void;
  /** Collapse the widget so the chart can use the full width. */
  onCollapse: () => void;
}

/**
 * Compact account summary shown beside the Account Balance chart when the
 * Transactions list is filtered to a single account. The pencil opens the same
 * edit modal used on the Accounts page via the supplied `onEdit` callback.
 */
export function AccountInfoWidget({
  account,
  currentBalance,
  institution,
  scheduledTransactions = [],
  refreshKey,
  switchableAccounts,
  onSwitchAccount,
  onEdit,
  onCollapse,
}: AccountInfoWidgetProps) {
  const t = useTranslations('transactions');
  const tc = useTranslations('common');
  // The caret reuses the account detail page's switcher copy, so the two
  // surfaces say the same thing.
  const ta = useTranslations('accountDetail');
  const router = useRouter();
  const { formatCurrency, formatPercentTrimmed } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  // Loan/mortgage figures: the current installment, the estimated payoff date
  // and the estimated remaining interest, derived from the account's payment
  // history exactly as the loan detail page derives them. `idle` for every other
  // account type, and nothing is fetched for those.
  const loan = useLoanProjection(account, refreshKey);

  // The account number is masked by default and only unmasked while the user
  // holds it open via the eye toggle. The state is intentionally not persisted,
  // so it re-masks on remount, and resets when switching to another account so
  // one account's number never leaks onto another. We follow the project's
  // "info from previous render" pattern rather than resetting in an effect.
  const [accountNumberVisible, setAccountNumberVisible] = useState(false);
  const [shownAccountId, setShownAccountId] = useState(account.id);
  if (shownAccountId !== account.id) {
    setShownAccountId(account.id);
    setAccountNumberVisible(false);
  }

  const isCreditCard = account.accountType === 'CREDIT_CARD';
  const balance = currentBalance ?? (Number(account.currentBalance) || 0);
  // Prefer the linked institution's canonical name; fall back to the legacy
  // free-text field stored on the account.
  const institutionName = institution?.name ?? account.institution ?? null;
  // Only treat http(s) URLs as a safe link target, to avoid javascript:/data:
  // URIs ever reaching the href.
  const institutionWebsite = toSafeExternalUrl(institution?.website);

  // One row per account the Accounts filter offers, each qualified by its type
  // the way the account detail page's switcher does, so alike-named accounts at
  // two banks are told apart. The order is `orderAccountsForPicker`'s -- the
  // starred accounts in the order the user arranged them, then the rest by name
  // -- so this menu opens on the same accounts, in the same order, as every
  // account `<select>` in the app.
  const switcherItems = useMemo<EntitySwitcherItem[]>(() => {
    const { favourites, rest } = orderAccountsForPicker(switchableAccounts ?? []);
    // Whether the menu is sectioned at all is decided by the favourites it will
    // actually OFFER, not by the ones the user has: `EntitySwitcher` drops the
    // account already on screen, so a reader whose only starred account is the
    // one they are looking at would otherwise get an "Other accounts" heading
    // over the whole list with nothing above it.
    const sectioned = favourites.some((candidate) => candidate.id !== account.id);
    const toItem = (candidate: Account, group?: string): EntitySwitcherItem => {
      const type = formatAccountType(candidate.accountType, tc);
      return {
        id: candidate.id,
        primary: candidate.name,
        secondary: type,
        // A starred account is still findable by its own name and type, so
        // typing narrows across both sections rather than only below the fold.
        searchText: `${candidate.name} ${type}`,
        group,
      };
    };
    // Emitted favourites-first because `EntitySwitcher` takes its section order
    // from the order the items appear in.
    return [
      ...favourites.map((candidate) =>
        toItem(candidate, sectioned ? ta('header.switchFavourites') : undefined),
      ),
      ...rest.map((candidate) =>
        toItem(candidate, sectioned ? ta('header.switchOtherAccounts') : undefined),
      ),
    ];
  }, [switchableAccounts, account.id, ta, tc]);

  // The soonest active scheduled bill/deposit booked against this account.
  const nextPayment = useMemo(
    () => getNextScheduled(scheduledTransactions, (st) => st.accountId === account.id),
    [scheduledTransactions, account.id],
  );

  const details: Array<{
    label: string;
    value: string;
    tooltip?: string;
    maskable?: boolean;
    /** The value is still loading; a placeholder stands in for it. */
    pending?: boolean;
  }> = [];
  details.push({
    label: t('accountWidget.type'),
    value: formatAccountType(account.accountType, tc),
  });
  if (account.accountNumber) {
    details.push({
      label: t('accountWidget.accountNumber'),
      value: account.accountNumber,
      maskable: true,
    });
  }
  details.push({ label: t('accountWidget.currency'), value: account.currencyCode });
  if (account.creditLimit != null && Number(account.creditLimit) !== 0) {
    details.push({
      label: t('accountWidget.creditLimit'),
      value: formatCurrency(Number(account.creditLimit), account.currencyCode),
    });
  }
  // The rate in effect, from the same resolution the payoff below is projected
  // at. `account.interestRate` is the OLD rate on any loan whose rate was
  // changed through the rate-history UI, so showing it here put one rate beside
  // a payoff computed from another. Falls back to the scalar while the
  // projection is loading, for a failed load, and for every non-loan account
  // (which have no rate history at all).
  // Gated on the RESOLVED rate, not on the scalar: a loan whose rate lives only
  // in its rate history has a null scalar, and gating on that hid the row
  // entirely while the payoff beside it was projected at that very rate.
  const displayedRate =
    loan.currentAnnualRate ??
    (account.interestRate != null ? Number(account.interestRate) : null);
  // The `!== 0` is deliberate HERE and nowhere else, and it is a statement about
  // this widget's audience rather than about the number: it renders for every
  // account type, and a chequing or asset account carrying a stored 0 has no
  // meaningful rate to show. On a loan surface 0% is a real rate and renders as
  // "0%" -- see the resolved-rate rule in CLAUDE.md.
  if (displayedRate != null && displayedRate !== 0) {
    details.push({
      label: t('accountWidget.interestRate'),
      value: `${formatPercentTrimmed(displayedRate)}`,
    });
  }
  if (loan.status !== 'idle') {
    // Every row is rendered even when its value is unknown: dropping one would
    // make "could not be worked out" look like "does not apply to this loan".
    const pending = loan.status === 'loading';
    const unknown = t('accountWidget.notAvailable');
    // A LINEAR or INTEREST_ONLY installment changes from one due date to the
    // next, so it is shown as the next one, with its date; an interest-only
    // mortgage adds its bullet (docs/specs/mortgage-types.md, section 5.6).
    details.push(
      loan.currentPaymentDate != null && loan.currentPayment != null
        ? {
            label: t('accountWidget.nextInstallment'),
            value: t('accountWidget.amountDueOn', {
              amount: formatCurrency(loan.currentPayment, account.currencyCode),
              date: formatDate(loan.currentPaymentDate),
            }),
            pending,
          }
        : {
            label: t('accountWidget.currentPayment'),
            value:
              loan.currentPayment != null
                ? formatCurrency(loan.currentPayment, account.currencyCode)
                : unknown,
            tooltip: t('accountWidget.currentPaymentTooltip'),
            pending,
          },
    );
    if (loan.finalPayment != null) {
      details.push({
        label: t('accountWidget.finalPayment'),
        value: t('accountWidget.amountDueOn', {
          amount: formatCurrency(loan.finalPayment.amount, account.currencyCode),
          date: formatDate(loan.finalPayment.date),
        }),
        pending,
      });
    }
    details.push({
      label: t('accountWidget.estPayoff'),
      value: loan.isSettled
        ? t('accountWidget.paidOff')
        : loan.payoffDate
          ? formatChartDate(loan.payoffDate, 'MMM yyyy')
          : unknown,
      pending,
    });
    details.push({
      label: t('accountWidget.estRemainingInterest'),
      value:
        loan.remainingInterest != null
          ? formatCurrency(loan.remainingInterest, account.currencyCode)
          : unknown,
      tooltip: t('accountWidget.estRemainingInterestTooltip'),
      pending,
    });
  }
  if (account.statementSettlementDay) {
    details.push({
      label: t('accountWidget.statementSettlement'),
      value: getOrdinal(account.statementSettlementDay),
      tooltip: t('accountWidget.statementSettlementTooltip'),
    });
  }
  if (account.statementDueDay) {
    details.push({
      label: t('accountWidget.statementDue'),
      value: getOrdinal(account.statementDueDay),
    });
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6 mb-6 lg:mb-0 lg:absolute lg:inset-x-0 lg:top-0 lg:bottom-6 lg:overflow-y-auto flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          {institutionWebsite ? (
            <a
              href={institutionWebsite}
              target="_blank"
              rel="noopener noreferrer"
              title={institutionWebsite}
              className="flex-shrink-0 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <InstitutionLogo institution={institution} size={40} fallbackGlyph="$" />
            </a>
          ) : (
            <InstitutionLogo institution={institution ?? undefined} size={40} fallbackGlyph="$" />
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1">
              <h3
                className="min-w-0 break-words text-lg font-semibold text-gray-900 sm:truncate dark:text-gray-100"
                title={account.name}
              >
                {account.name}
              </h3>
              {/* Jump straight to another account the Accounts filter offers,
                  instead of reopening the filter and picking it there. */}
              {onSwitchAccount && switcherItems.length > 0 && (
                <EntitySwitcher
                  currentId={account.id}
                  items={switcherItems}
                  onSelect={onSwitchAccount}
                  triggerLabel={ta('header.switchAccount')}
                  filterPlaceholder={ta('header.switchPlaceholder')}
                  noMatchesLabel={ta('header.switchNoMatches')}
                />
              )}
            </div>
            {(institutionName || account.isClosed) && (
              <div className="flex items-center gap-2 min-w-0">
                {institutionName && (
                  <p
                    className="min-w-0 break-words text-sm text-gray-500 sm:truncate dark:text-gray-400"
                    title={institutionName}
                  >
                    {institutionName}
                  </p>
                )}
                {account.isClosed && (
                  <span className="flex-shrink-0 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    {t('accountWidget.closed')}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => router.push(`/accounts/${account.id}`)}
            aria-label={t('accountWidget.viewDetailsAria')}
            title={t('accountWidget.viewDetailsAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            {/* Eye, matching the payee widget's link to its own detail page. */}
            <EyeIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('accountWidget.editAria')}
            title={t('accountWidget.editAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <PencilSquareIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('accountWidget.collapseAria')}
            title={t('accountWidget.collapseAria')}
            className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded p-1"
          >
            <ChevronDoubleLeftIcon className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('accountWidget.currentBalance')}
        </p>
        <p className={`text-2xl font-bold ${balanceColor(balance)}`}>
          {formatCurrency(balance, account.currencyCode)}
        </p>
      </div>

      {nextPayment && (
        <button
          type="button"
          onClick={() => router.push('/bills')}
          title={t('accountWidget.viewBills')}
          className="mb-4 w-full text-left rounded-md bg-gray-50 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 transition-colors px-3 py-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('accountWidget.nextPayment')}
              </p>
              <p
                className={`text-base font-semibold ${
                  nextPayment.amount !== null && nextPayment.amount < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-green-600 dark:text-green-400'
                }`}
              >
                {/* An occurrence whose current amount could not be resolved is shown
                  as unavailable, never as its stale stored figure (issue
                  #1247). */}
              {nextPayment.amount === null ? (
                <UnknownAmount />
              ) : (
                formatCurrency(Math.abs(nextPayment.amount), nextPayment.currencyCode)
              )}
              </p>
            </div>
            <div className="text-right min-w-0">
              {nextPayment.payeeName && (
                <p className="text-sm text-gray-700 dark:text-gray-300 truncate">
                  {nextPayment.payeeName}
                </p>
              )}
              <p className="text-base font-semibold text-gray-700 dark:text-gray-300">
                {formatDate(nextPayment.date)}
              </p>
            </div>
          </div>
        </button>
      )}

      <dl className="space-y-2 text-sm">
        {details.map((detail) => (
          <div key={detail.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-gray-500 dark:text-gray-400 flex-shrink-0 flex items-center">
              {detail.label}
              {detail.tooltip && <InfoTooltip text={detail.tooltip} usePortal />}
            </dt>
            {detail.pending ? (
              <dd
                aria-busy="true"
                aria-label={tc('loading')}
                className="min-w-0 flex items-center justify-end"
              >
                <span className="h-4 w-16 rounded bg-gray-200 dark:bg-gray-700 animate-pulse skeleton-shimmer motion-reduce:animate-none" />
              </dd>
            ) : detail.maskable ? (
              <dd className="text-gray-900 dark:text-gray-100 min-w-0 flex items-center justify-end gap-1.5">
                <span className="truncate tracking-wider">
                  {accountNumberVisible
                    ? detail.value
                    : maskAccountNumber(detail.value, isCreditCard)}
                </span>
                <button
                  type="button"
                  onClick={() => setAccountNumberVisible((v) => !v)}
                  aria-label={
                    accountNumberVisible
                      ? t('accountWidget.hideAccountNumber')
                      : t('accountWidget.showAccountNumber')
                  }
                  title={
                    accountNumberVisible
                      ? t('accountWidget.hideAccountNumber')
                      : t('accountWidget.showAccountNumber')
                  }
                  className="flex-shrink-0 text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
                >
                  {accountNumberVisible ? (
                    <EyeSlashIcon className="h-4 w-4" />
                  ) : (
                    <EyeIcon className="h-4 w-4" />
                  )}
                </button>
              </dd>
            ) : (
              <dd
                className="min-w-0 break-words text-gray-900 dark:text-gray-100 text-right sm:truncate"
                title={detail.value}
              >
                {detail.value}
              </dd>
            )}
          </div>
        ))}
      </dl>

      {account.description && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 break-words">
          {account.description}
        </p>
      )}

    </div>
  );
}
