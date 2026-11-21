import { ReactNode } from 'react';
import {
  BuildingLibraryIcon,
  ChartBarIcon,
  CheckCircleIcon,
  CheckIcon,
  ClipboardDocumentListIcon,
  ClockIcon,
  CurrencyDollarIcon,
  ExclamationTriangleIcon,
  ListBulletIcon,
  MinusIcon,
  NoSymbolIcon,
  PlusCircleIcon,
  PlusIcon,
  TagIcon,
  UsersIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { CARD_CLASS } from '@/components/ui/Card';

interface SummaryCardProps {
  /** Label text (e.g., "Total Accounts") */
  label: string;
  /** Value to display (can be string or number) */
  value: ReactNode;
  /** Icon element - should be an SVG with size h-6 w-6 */
  icon: ReactNode;
  /** Color variant for the value text */
  valueColor?: 'default' | 'green' | 'red' | 'blue' | 'yellow';
  /**
   * One line under the value, for a figure that is withheld rather than
   * measured: what is missing and where to fix it. A blank where a number
   * should be is indistinguishable from "nothing to report", so a card showing
   * an unavailable value says why (`docs/financial-semantics.md`).
   */
  hint?: ReactNode;
  /** Optional click handler */
  onClick?: () => void;
  /**
   * The row's headline figure. Standard draws it like the others; Pebble sets
   * it as the accent block and Folio under a heavier rule
   * (`ui-stat-lead`, `ui-styles-kit.css`). One per row at most.
   */
  lead?: boolean;
}

const valueColorClasses = {
  default: 'text-gray-900 dark:text-gray-100',
  green: 'text-green-600 dark:text-green-400',
  red: 'text-red-600 dark:text-red-400',
  blue: 'text-blue-600 dark:text-blue-400',
  yellow: 'text-yellow-600 dark:text-yellow-400',
};

/**
 * Summary card component used across pages for displaying key metrics.
 * Provides consistent styling for summary statistics at the top of pages.
 *
 * The `ui-stat*` markers let the UI styles re-set a row of these
 * (`ui-styles-kit.css`): Folio prints the row as a ruled statement line,
 * Pebble as white blocks with a large figure. A money value set as
 * `<MoneyFigure display>` is typeset by both.
 */
export function SummaryCard({
  label,
  value,
  icon,
  valueColor = 'default',
  hint,
  onClick,
  lead = false,
}: SummaryCardProps) {
  const content = (
    <div className="ui-stat-body p-3 sm:p-5">
      <div className="flex items-center">
        <div className="ui-stat-icon flex-shrink-0 hidden sm:flex h-10 w-10 items-center justify-center rounded-lg bg-gray-50 dark:bg-gray-700/50">
          {icon}
        </div>
        <div className="sm:ml-4 w-0 flex-1">
          <dl>
            <dt className="ui-stat-label text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400 truncate">
              {label}
            </dt>
            <dd className={`ui-stat-value text-base sm:text-lg font-semibold ${valueColorClasses[valueColor]}`}>
              {value}
            </dd>
            {hint && (
              <dd className="ui-stat-hint mt-1 text-xs text-gray-500 dark:text-gray-400">
                {hint}
              </dd>
            )}
          </dl>
        </div>
      </div>
    </div>
  );

  const baseClasses = `ui-stat${lead ? ' ui-stat-lead' : ''} ${CARD_CLASS} overflow-hidden`;

  if (onClick) {
    return (
      <button
        onClick={onClick}
        className={`${baseClasses} w-full text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors`}
      >
        {content}
      </button>
    );
  }

  return <div className={baseClasses}>{content}</div>;
}

// Common icon components for reuse. Heroicons now, but the export shape --
// a ready ReactNode per key, tint included -- is unchanged so no call site
// moves. The green/red/yellow tints are semantic (ok/problem/attention);
// the neutral entries stay on the gray ramp.
export const SummaryIcons = {
  accounts: <BuildingLibraryIcon className="h-6 w-6 text-gray-400 dark:text-gray-500" />,
  money: <CurrencyDollarIcon className="h-6 w-6 text-blue-400" />,
  checkmark: <CheckIcon className="h-6 w-6 text-green-400" />,
  cross: <XMarkIcon className="h-6 w-6 text-red-400" />,
  plus: <PlusIcon className="h-6 w-6 text-green-400" />,
  minus: <MinusIcon className="h-6 w-6 text-red-400" />,
  tag: <TagIcon className="h-6 w-6 text-gray-400 dark:text-gray-500" />,
  list: <ListBulletIcon className="h-6 w-6 text-blue-400" />,
  users: <UsersIcon className="h-6 w-6 text-gray-400 dark:text-gray-500" />,
  checkCircle: <CheckCircleIcon className="h-6 w-6 text-green-400" />,
  warning: <ExclamationTriangleIcon className="h-6 w-6 text-yellow-400" />,
  plusCircle: <PlusCircleIcon className="h-6 w-6 text-green-400" />,
  barChart: <ChartBarIcon className="h-6 w-6 text-gray-400 dark:text-gray-500" />,
  ban: <NoSymbolIcon className="h-6 w-6 text-gray-400" />,
  clipboard: <ClipboardDocumentListIcon className="h-6 w-6 text-red-400" />,
  clock: <ClockIcon className="h-6 w-6 text-yellow-400" />,
};
