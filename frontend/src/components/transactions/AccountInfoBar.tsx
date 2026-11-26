'use client';

import type { ReactNode, Ref } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ChevronDownIcon, EyeIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { Account } from '@/types/account';
import { balanceColor } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { CARD_CLASS } from '@/components/ui/Card';
import { ProvisionalMark } from '@/components/ui/ProvisionalMark';
import { InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { AccountIdentity, accountWidgetBalance } from '@/components/transactions/AccountIdentity';

interface AccountInfoBarProps {
  account: Account;
  /** The same live balance the full widget shows. */
  currentBalance?: number;
  institution?: (InstitutionLogoData & { website?: string }) | null;
  /** The accounts the caret beside the name may switch to. */
  switchableAccounts?: readonly Account[];
  onSwitchAccount?: (accountId: string) => void;
  /** Lands on the account's name (see `AccountIdentity`). */
  nameRef?: Ref<HTMLHeadingElement>;
  /** Open the shared account edit modal for this account (desktop only). */
  onEdit: () => void;
  /** Bring back the full widget. */
  onExpand: () => void;
  /**
   * The copy inside `FloatingPageBar` once the account's band has scrolled
   * away: no card of its own (the floating bar draws the header's surface and
   * the page gutters), and its own test id so it is never mistaken for the
   * bar in the band.
   */
  floating?: boolean;
  /** Drawn last, at the right end: the floating bar's "+" for a new transaction. */
  trailing?: ReactNode;
}

const ICON_BUTTON_CLASS =
  'text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded p-1';

/**
 * The slim, full-width bar the Account Info widget folds into on the
 * Transactions page: the account's logo, name and institution on the left, its
 * current balance on the right, with the caret beside the name that switches
 * accounts. A desktop adds the details and edit icons; a phone keeps only the
 * expand chevron.
 */
export function AccountInfoBar({
  account,
  currentBalance,
  institution,
  switchableAccounts,
  onSwitchAccount,
  nameRef,
  onEdit,
  onExpand,
  floating = false,
  trailing,
}: AccountInfoBarProps) {
  const t = useTranslations('transactions');
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const balance = accountWidgetBalance(account, currentBalance);

  return (
    <div
      data-testid={floating ? 'account-info-floating-bar' : 'account-info-bar'}
      className={`${
        floating ? '' : `${CARD_CLASS} mb-4 px-3 sm:px-4`
      } flex items-center justify-between gap-3 py-2`}
    >
      <AccountIdentity
        account={account}
        institution={institution}
        switchableAccounts={switchableAccounts}
        onSwitchAccount={onSwitchAccount}
        nameRef={nameRef}
        size="compact"
      />
      <div className="flex flex-shrink-0 items-center gap-2">
        <span
          className={`text-base font-semibold sm:text-lg ${balanceColor(balance)}`}
          title={t('accountWidget.currentBalance')}
        >
          {formatCurrency(balance, account.currencyCode)}
          <ProvisionalMark count={account.provisionalCount} />
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => router.push(`/accounts/${account.id}`)}
            aria-label={t('accountWidget.viewDetailsAria')}
            title={t('accountWidget.viewDetailsAria')}
            className={`hidden lg:inline-flex ${ICON_BUTTON_CLASS}`}
          >
            <EyeIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            aria-label={t('accountWidget.editAria')}
            title={t('accountWidget.editAria')}
            className={`hidden lg:inline-flex ${ICON_BUTTON_CLASS}`}
          >
            <PencilSquareIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onExpand}
            aria-expanded={false}
            aria-label={t('accountWidget.show')}
            title={t('accountWidget.show')}
            className={`inline-flex ${ICON_BUTTON_CLASS}`}
          >
            <ChevronDownIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {trailing}
      </div>
    </div>
  );
}
