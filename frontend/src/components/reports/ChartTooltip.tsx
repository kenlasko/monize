import { ReactNode } from 'react';
import { CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

/** One series entry as Recharts hands it to a tooltip `content` renderer. */
export interface ChartTooltipEntry {
  name?: string;
  value?: number;
  color?: string;
  /** The full data row this entry came from (Recharts populates it). */
  payload?: Record<string, unknown>;
}

interface ChartTooltipProps {
  /** Recharts sets this true only while the tooltip is visible. */
  active?: boolean;
  /** Heading shown above the entries (e.g. the category/month name). */
  label?: ReactNode;
  /** Series rows to render as "name: value" lines. */
  payload?: readonly ChartTooltipEntry[];
  /** Formats each entry's numeric value (defaults to String). */
  formatValue?: (value: number, entry: ChartTooltipEntry) => string;
  /** Extra content rendered below the entries (e.g. a percentage line). */
  children?: ReactNode;
  /**
   * Extra content derived from the hovered row's raw data (the first entry's
   * `payload`), rendered below the entries -- e.g. a per-point annotation that
   * isn't itself a plotted series.
   */
  extra?: (point: Record<string, unknown>) => ReactNode;
}

/**
 * Shared dark-mode-aware panel used as the Recharts `<Tooltip content={...}>`
 * across the report charts. Replaces the ~23 hand-rolled `CustomTooltip`
 * components that all repeated the same
 * `bg-white dark:bg-gray-800 border ... rounded-lg shadow-lg p-3` panel with a
 * bold label and per-entry coloured `name: value` lines.
 *
 * Returns null when inactive (matching the Recharts contract). For tooltips
 * that need fully custom inner markup, use `<ChartTooltipPanel>` directly and
 * compose your own body.
 */
export function ChartTooltip({
  active,
  label,
  payload,
  formatValue = (v) => String(v),
  children,
  extra,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  return (
    <ChartTooltipPanel>
      {label !== undefined && label !== null && (
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
      )}
      {payload.map((entry, index) => (
        <p key={index} className="text-sm" style={{ color: entry.color }}>
          {entry.name}: {entry.value === undefined ? '' : formatValue(entry.value, entry)}
        </p>
      ))}
      {extra && payload[0]?.payload && extra(payload[0].payload)}
      {children}
    </ChartTooltipPanel>
  );
}

/**
 * The bare tooltip panel (dark-mode card). Use when a chart's tooltip body is
 * too bespoke for `<ChartTooltip>` but should still share the panel chrome.
 */
export function ChartTooltipPanel({ children }: { children: ReactNode }) {
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      {children}
    </div>
  );
}
