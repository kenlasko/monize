'use client';

import type { ComponentType, ReactNode, SVGProps } from 'react';
import Link from 'next/link';
import {
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ArrowTrendingUpIcon,
  ArrowsUpDownIcon,
  BanknotesIcon,
  BookmarkIcon,
  BriefcaseIcon,
  BuildingLibraryIcon,
  BuildingOffice2Icon,
  CalendarDaysIcon,
  CalendarIcon,
  ChartBarSquareIcon,
  ChartBarIcon,
  ChartPieIcon,
  ClipboardDocumentCheckIcon,
  CreditCardIcon,
  GlobeAltIcon,
  LightBulbIcon,
  PresentationChartLineIcon,
  RectangleGroupIcon,
  ScaleIcon,
  ShieldCheckIcon,
  StarIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
// Type-only import: erased at compile time, so no runtime cycle with the
// registry (which imports the widgets, which import WidgetCard, which
// imports this file).
import type { DashboardWidgetId } from './widget-registry';

type WidgetIconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Per-widget icon for the dashboard card headers. Distinct per widget on
 * purpose -- the registry's `iconType` (bar/line/pie/table/list) is about the
 * visualization kind and repeats five glyphs across 22 widgets, which is no
 * differentiation at all. `widget-meta.test.tsx` holds "every registered
 * widget has an icon".
 */
export const WIDGET_ICONS: Record<DashboardWidgetId, WidgetIconComponent> = {
  'favourite-accounts': BuildingLibraryIcon,
  'upcoming-bills': CalendarDaysIcon,
  'cash-flow-forecast': ChartBarSquareIcon,
  'top-movers': ArrowTrendingUpIcon,
  'favourite-securities': StarIcon,
  'portfolio-value': PresentationChartLineIcon,
  'net-worth': ScaleIcon,
  'assets-liabilities': BanknotesIcon,
  'expenses-pie': ChartPieIcon,
  'income-expenses': ArrowsUpDownIcon,
  'budget-status': ClipboardDocumentCheckIcon,
  insights: LightBulbIcon,
  'favourite-reports': BookmarkIcon,
  'spending-by-payee': UsersIcon,
  'monthly-spending-trend': ChartBarIcon,
  'income-by-source': BriefcaseIcon,
  'credit-utilization-accounts': CreditCardIcon,
  'credit-utilization-total': CreditCardIcon,
  'sector-weightings': BuildingOffice2Icon,
  'security-type-allocation': RectangleGroupIcon,
  'geographic-allocation': GlobeAltIcon,
  'recurring-expenses': ArrowPathIcon,
  'weekend-weekday': CalendarIcon,
  'cash-flow-sankey': ArrowsRightLeftIcon,
  'warranties-expiring': ShieldCheckIcon,
};

export type WidgetDomain = 'accounts' | 'investments' | 'bills' | 'insights';

/**
 * The part of the app each widget belongs to, which sets its tint so a long
 * dashboard can be scanned by colour. `bills` is anything about what is coming
 * due, `insights` anything that analyses past spending and income.
 */
export const WIDGET_DOMAINS: Record<DashboardWidgetId, WidgetDomain> = {
  'favourite-accounts': 'accounts',
  'net-worth': 'accounts',
  'assets-liabilities': 'accounts',
  'credit-utilization-accounts': 'accounts',
  'credit-utilization-total': 'accounts',
  'top-movers': 'investments',
  'favourite-securities': 'investments',
  'portfolio-value': 'investments',
  'sector-weightings': 'investments',
  'security-type-allocation': 'investments',
  'geographic-allocation': 'investments',
  'upcoming-bills': 'bills',
  'cash-flow-forecast': 'bills',
  'recurring-expenses': 'bills',
  'warranties-expiring': 'bills',
  insights: 'insights',
  'favourite-reports': 'insights',
  'expenses-pie': 'insights',
  'income-expenses': 'insights',
  'budget-status': 'insights',
  'spending-by-payee': 'insights',
  'monthly-spending-trend': 'insights',
  'income-by-source': 'insights',
  'weekend-weekday': 'insights',
  'cash-flow-sankey': 'insights',
};

/**
 * Chart tokens, so a palette recolours the domains with everything else. The
 * categorical slots rather than the semantic ones (`--chart-warning`): a bill
 * is not a warning, and the slots are the set each palette keeps apart.
 */
const DOMAIN_TOKEN: Record<WidgetDomain, string> = {
  accounts: '[--widget-tint:var(--chart-primary)]',
  investments: '[--widget-tint:var(--chart-5)]',
  bills: '[--widget-tint:var(--chart-3)]',
  insights: '[--widget-tint:var(--chart-7)]',
};

// The tokens are pitched for a line on a card, so on a light tile the glyph is
// darkened: amber at full strength would be barely visible on its own wash.
const TINT_CLASS =
  'bg-[color-mix(in_srgb,var(--widget-tint)_14%,transparent)] text-[color-mix(in_srgb,var(--widget-tint)_75%,black)] dark:bg-[color-mix(in_srgb,var(--widget-tint)_20%,transparent)] dark:text-[var(--widget-tint)]';

/** The wash and glyph colour of a widget's domain, for anything standing in for it. */
export function widgetTintClass(id: DashboardWidgetId): string {
  return `${DOMAIN_TOKEN[WIDGET_DOMAINS[id]]} ${TINT_CLASS}`;
}

/** The tinted icon puck before a widget title, coloured by the widget's domain. */
export function WidgetIconPuck({ id }: { id: DashboardWidgetId }) {
  const Icon = WIDGET_ICONS[id];
  if (!Icon) return null;
  return (
    <span
      aria-hidden
      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${widgetTintClass(id)}`}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}

const TITLE_CLASS = 'text-lg font-semibold text-gray-900 dark:text-gray-100';

/**
 * A widget's heading text, as a link to the fuller view of the same figures
 * when `href` is given and a plain heading when it is not.
 *
 * One mechanism for every widget: `WidgetHeading` (the core widgets, which draw
 * their own card header) and `WidgetCard` (the report-derived ones) both render
 * the title through this, so the target is named as a route in the widget and
 * the affordance is written once.
 */
export function WidgetTitle({
  href,
  className = '',
  children,
}: {
  /** Route the title navigates to. Omit for a widget with no fuller view. */
  href?: string;
  /** Extra classes on the heading element. */
  className?: string;
  children: ReactNode;
}) {
  const headingClass = `${TITLE_CLASS} truncate ${className}`.trimEnd();
  if (!href) return <h3 className={headingClass}>{children}</h3>;
  return (
    <h3 className={headingClass}>
      <Link
        href={href}
        className="rounded-sm hover:text-blue-600 dark:hover:text-blue-400 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        {children}
      </Link>
    </h3>
  );
}

/**
 * Icon puck + title for the widgets that draw their own card header (the
 * core widgets predating `WidgetCard`). With `href` the title links to the
 * fuller view; without, it is a plain heading.
 */
export function WidgetHeading({
  id,
  href,
  className = '',
  children,
}: {
  id: DashboardWidgetId;
  href?: string;
  /** Extra classes on the wrapper (e.g. `mb-4` where the heading stands alone). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${className}`}>
      <WidgetIconPuck id={id} />
      <WidgetTitle href={href}>{children}</WidgetTitle>
    </div>
  );
}
