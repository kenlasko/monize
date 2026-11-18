'use client';

import type { Ref } from 'react';
import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { InstitutionLogo, InstitutionLogoData } from '@/components/institutions/InstitutionLogo';
import { Badge } from '@/components/ui/Badge';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import { useAccountSwitcherItems } from '@/hooks/useAccountSwitcherItems';
import { toSafeExternalUrl } from '@/lib/external-url';

export interface AccountIdentityProps {
  account: Account;
  /** The account's institution, when assigned, for the logo + name. The
   *  optional website makes the logo a link to the institution's site. */
  institution?: (InstitutionLogoData & { website?: string }) | null;
  /**
   * The accounts the Accounts filter currently offers -- already narrowed by
   * the Show Accounts (All/Active/Closed) toggle -- so the caret beside the
   * name switches only to an account the filter itself could select. Omit to
   * hide the caret.
   */
  switchableAccounts?: readonly Account[];
  /** Narrow the list to the chosen account, leaving every other filter as is. */
  onSwitchAccount?: (accountId: string) => void;
  /** `compact` is the slim one-line bar the folded widget becomes. */
  size?: 'regular' | 'compact';
  /** Lands on the account's name, for a page that watches whether it is on screen. */
  nameRef?: Ref<HTMLHeadingElement>;
}

/**
 * The institution logo, the account's name with the caret that switches to
 * another account, and the institution's name under it. Shared by the full
 * Account Info widget and the slim bar it folds into, so the two always
 * identify the account the same way.
 */
export function AccountIdentity({
  account,
  institution,
  switchableAccounts,
  onSwitchAccount,
  size = 'regular',
  nameRef,
}: AccountIdentityProps) {
  const t = useTranslations('transactions');
  // The caret reuses the account detail page's switcher copy, so the two
  // surfaces say the same thing.
  const ta = useTranslations('accountDetail');
  const compact = size === 'compact';
  const logoSize = compact ? 32 : 40;

  // Prefer the linked institution's canonical name; fall back to the legacy
  // free-text field stored on the account.
  const institutionName = institution?.name ?? account.institution ?? null;
  // Only treat http(s) URLs as a safe link target, to avoid javascript:/data:
  // URIs ever reaching the href.
  const institutionWebsite = toSafeExternalUrl(institution?.website);

  const switcherItems = useAccountSwitcherItems(switchableAccounts, account.id);

  return (
    <div className="flex items-center gap-3 min-w-0">
      {institutionWebsite ? (
        <a
          href={institutionWebsite}
          target="_blank"
          rel="noopener noreferrer"
          title={institutionWebsite}
          className="flex-shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          <InstitutionLogo institution={institution} size={logoSize} fallbackGlyph="$" />
        </a>
      ) : (
        <InstitutionLogo institution={institution ?? undefined} size={logoSize} fallbackGlyph="$" />
      )}
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1">
          <h3
            ref={nameRef}
            className={
              compact
                ? 'min-w-0 truncate text-base font-semibold text-gray-900 dark:text-gray-100'
                : 'min-w-0 break-words text-lg font-semibold text-gray-900 sm:truncate dark:text-gray-100'
            }
            title={account.name}
          >
            {account.name}
          </h3>
          {/* Jump straight to another account the Accounts filter offers,
              instead of reopening the filter and picking it there. */}
          {onSwitchAccount && switcherItems.length > 0 && (
            <span className="inline-flex flex-shrink-0 items-center">
              <EntitySwitcher
                currentId={account.id}
                items={switcherItems}
                onSelect={onSwitchAccount}
                triggerLabel={ta('header.switchAccount')}
                filterPlaceholder={ta('header.switchPlaceholder')}
                noMatchesLabel={ta('header.switchNoMatches')}
              />
            </span>
          )}
        </div>
        {(institutionName || account.isClosed) && (
          <div className="flex items-center gap-2 min-w-0">
            {institutionName && (
              <p
                className={
                  compact
                    ? 'min-w-0 truncate text-xs text-gray-500 dark:text-gray-400'
                    : 'min-w-0 break-words text-sm text-gray-500 sm:truncate dark:text-gray-400'
                }
                title={institutionName}
              >
                {institutionName}
              </p>
            )}
            {account.isClosed && (
              <Badge className="flex-shrink-0">{t('accountWidget.closed')}</Badge>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The balance the widget and its folded bar both show: the live figure from
 * the page's daily-balance series, else the account's stored balance.
 */
export function accountWidgetBalance(account: Account, currentBalance?: number): number {
  return currentBalance ?? (Number(account.currentBalance) || 0);
}
