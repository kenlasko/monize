'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { DASHBOARD_WIDGETS, type DashboardWidgetId, type WidgetIconType } from './widget-registry';
import { widgetTintClass } from './widget-meta';

const DEFINITIONS = new Map(DASHBOARD_WIDGETS.map((w) => [w.id, w]));

/** A widget's glyph on its domain's colour, the one its puck wears on the dashboard. */
export function WidgetTint({ id, children }: { id: DashboardWidgetId; children: ReactNode }) {
  return (
    <span
      data-testid={`widget-tint-${id}`}
      className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded ${widgetTintClass(id)}`}
    >
      {children}
    </span>
  );
}

/**
 * Small glyph hinting at the kind of visualization a widget renders (bar, line,
 * pie, table, or list), so widgets can be told apart at a glance where they
 * stand in for themselves: the Add widget dialog and edit mode's placeholder tile.
 */
export function WidgetTypeIcon({ type }: { type: WidgetIconType }) {
  const common = {
    className: 'h-3.5 w-3.5 flex-shrink-0',
    fill: 'none',
    viewBox: '0 0 24 24',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    'data-testid': `widget-type-icon-${type}`,
  };
  switch (type) {
    case 'bar':
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M6 21v-7" />
          <path d="M12 21V5" />
          <path d="M18 21v-11" />
        </svg>
      );
    case 'line':
      return (
        <svg {...common}>
          <path d="M3 21h18" />
          <path d="M4 15l5-5 4 3 7-8" />
        </svg>
      );
    case 'pie':
      return (
        <svg {...common}>
          <path d="M10.5 6a7.5 7.5 0 107.5 7.5h-7.5V6Z" />
          <path d="M13.5 10.5H21A7.5 7.5 0 0013.5 3v7.5Z" />
        </svg>
      );
    case 'table':
      return (
        <svg {...common}>
          <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
          <path d="M3.5 10.5h17" />
          <path d="M3.5 14.5h17" />
          <path d="M9.5 5.5v13" />
        </svg>
      );
    case 'list':
    default:
      return (
        <svg {...common}>
          <path d="M8 6.5h12" />
          <path d="M8 12h12" />
          <path d="M8 17.5h12" />
          <path d="M4 6.5h.01" />
          <path d="M4 12h.01" />
          <path d="M4 17.5h.01" />
        </svg>
      );
  }
}

/** The tint and type glyph together, as a widget is shown wherever it stands in for itself. */
export function WidgetGlyph({ id }: { id: DashboardWidgetId }) {
  const type = DEFINITIONS.get(id)?.iconType ?? 'list';
  return (
    <WidgetTint id={id}>
      <WidgetTypeIcon type={type} />
    </WidgetTint>
  );
}

/** A widget's display name, from its registry title section. */
export function useWidgetName(): (id: DashboardWidgetId) => string {
  const t = useTranslations('dashboard');
  return (id) => {
    const section = DEFINITIONS.get(id)?.titleSection;
    return section ? t(`${section}.title` as Parameters<typeof t>[0]) : id;
  };
}
