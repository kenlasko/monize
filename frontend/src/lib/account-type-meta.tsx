import type { ComponentType, SVGProps } from 'react';
import {
  ArrowTrendingUpIcon,
  BanknotesIcon,
  BuildingLibraryIcon,
  CreditCardIcon,
  CubeIcon,
  CubeTransparentIcon,
  DocumentTextIcon,
  HomeIcon,
  ReceiptPercentIcon,
  Squares2X2Icon,
  WalletIcon,
} from '@heroicons/react/24/outline';
import { AccountType } from '@/types/account';

type TypeIcon = ComponentType<SVGProps<SVGSVGElement>>;

interface AccountTypeMeta {
  /** Tailwind classes for the type pill; ramp classes only, so the colour
   *  themes re-skin them. */
  pillClass: string;
  Icon: TypeIcon;
}

/**
 * The one place an account type maps to its pill colour and icon. The colour
 * switch used to live inside `AccountList` and the type had no icon anywhere,
 * so every other surface that wanted to mark an account's type either
 * hand-rolled a copy or went without. `ui-conventions.test.ts` fails on a new
 * type-to-pill-class switch outside this module.
 */
export const ACCOUNT_TYPE_META: Record<AccountType, AccountTypeMeta> = {
  CHEQUING: {
    pillClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
    Icon: BuildingLibraryIcon,
  },
  SAVINGS: {
    pillClass: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
    Icon: BanknotesIcon,
  },
  CREDIT_CARD: {
    pillClass: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
    Icon: CreditCardIcon,
  },
  INVESTMENT: {
    pillClass: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
    Icon: ArrowTrendingUpIcon,
  },
  LOAN: {
    pillClass: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
    Icon: DocumentTextIcon,
  },
  MORTGAGE: {
    pillClass: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
    Icon: HomeIcon,
  },
  CASH: {
    pillClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    Icon: WalletIcon,
  },
  LINE_OF_CREDIT: {
    pillClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200',
    Icon: ReceiptPercentIcon,
  },
  ASSET: {
    pillClass: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200',
    Icon: CubeIcon,
  },
  CRYPTO: {
    pillClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
    Icon: CubeTransparentIcon,
  },
  OTHER: {
    pillClass: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
    Icon: Squares2X2Icon,
  },
};

const FALLBACK_META = ACCOUNT_TYPE_META.OTHER;

export function accountTypePillClass(type: AccountType): string {
  return (ACCOUNT_TYPE_META[type] ?? FALLBACK_META).pillClass;
}

/** Decorative type glyph; sized by the caller via className. */
export function AccountTypeIcon({
  type,
  className = 'h-3.5 w-3.5',
}: {
  type: AccountType;
  className?: string;
}) {
  const { Icon } = ACCOUNT_TYPE_META[type] ?? FALLBACK_META;
  return <Icon aria-hidden className={`flex-shrink-0 ${className}`} />;
}

/** The full type pill: tinted background, icon, and the caller's label. */
export function AccountTypePill({
  type,
  children,
  className = '',
}: {
  type: AccountType;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`px-2 inline-flex items-center gap-1 text-xs leading-5 font-semibold rounded-full ${accountTypePillClass(type)} ${className}`}
    >
      <AccountTypeIcon type={type} className="h-3 w-3" />
      {children}
    </span>
  );
}
