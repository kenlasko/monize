import type { AccountType } from '@/types/account';
import type { AccountOpenTarget } from '@/lib/view-defaults';

/**
 * Which per-type detail view an account opens on `/accounts/<id>`.
 *
 * The dedicated pages the account list's **Details** row action reaches. A type
 * absent from the registry has no dedicated page yet and its detail route
 * redirects to the transaction register instead.
 */
export type AccountDetailViewKind =
  | 'loan'
  | 'lineOfCredit'
  | 'creditCard'
  | 'banking'
  | 'investment'
  | 'asset';

/**
 * The registry itself, and the single place "which account types have a
 * detail page" is written. Three surfaces ask that question -- the detail
 * route (which view to render), the account row (whether to offer **Details**)
 * and the introduction tour (whether its account-detail step has anything to
 * open) -- so the answer is derived here rather than restated three times.
 */
export const ACCOUNT_DETAIL_VIEWS: Partial<Record<AccountType, AccountDetailViewKind>> = {
  LOAN: 'loan',
  MORTGAGE: 'loan',
  LINE_OF_CREDIT: 'lineOfCredit',
  CREDIT_CARD: 'creditCard',
  CHEQUING: 'banking',
  SAVINGS: 'banking',
  CASH: 'banking',
  CRYPTO: 'banking',
  INVESTMENT: 'investment',
  ASSET: 'asset',
  OTHER: 'asset',
};

/** The detail view for an account type, or null when it has no dedicated page. */
export function resolveAccountDetailView(
  type: AccountType,
): AccountDetailViewKind | null {
  return ACCOUNT_DETAIL_VIEWS[type] ?? null;
}

/**
 * Account types with a dedicated detail page, derived from the registry so the
 * list and the views it stands for cannot drift apart.
 */
export const DETAIL_ACCOUNT_TYPES: readonly AccountType[] = Object.keys(
  ACCOUNT_DETAIL_VIEWS,
) as AccountType[];

/** Whether an account of this type can open a dedicated detail page. */
export function hasAccountDetailView(
  type: AccountType | undefined | null,
): boolean {
  return type != null && resolveAccountDetailView(type) !== null;
}

/**
 * Whether clicking an account opens its detail page (its dashboard) rather
 * than the surface's usual register: the reader chose the dashboard (the
 * `accountOpenTarget` view default) and the type has one. A type without a
 * detail page opens the register whatever the choice.
 */
export function opensAccountDashboard(
  type: AccountType | undefined | null,
  target: AccountOpenTarget,
): boolean {
  return target === 'dashboard' && hasAccountDetailView(type);
}
