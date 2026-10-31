'use client';

import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { ChartLegend } from '@/components/ui/ChartLegend';
import { DonutCenterTotal } from '@/components/ui/DonutCenterTotal';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { CalloutLayoutOptions, DEFAULT_CALLOUT_OPTIONS, layoutCallouts } from './donut-callout-layout';

/** One slice as the chart draws it. */
export interface DonutCalloutSlice {
  /** Stable React key. */
  key: string;
  name: string;
  value: number;
  color: string;
  /** What a click on the slice, its box or its legend row does; omit for an inert slice. */
  onClick?: () => void;
}

export type DonutCalloutView = 'callouts' | 'legend';

/** Pixels, or a percentage string as Recharts' Pie reads one. */
type PieRadius = number | string;

interface DonutCalloutChartProps<T extends DonutCalloutSlice> {
  slices: readonly T[];
  view: DonutCalloutView;
  /** Accessible name of the list of callout boxes. */
  label: string;
  /** The figure under each name in a box, and at a legend row's end. */
  formatValue: (value: number) => string;
  /** Body of the hover tooltip for one slice. */
  renderTooltip: (slice: T) => ReactNode;
  /** The aggregate drawn in the donut's hole. */
  center?: {
    label: ReactNode;
    value: ReactNode;
    /**
     * The same figure in compact notation ("$123.5K"), drawn in the callout
     * view, whose hole is the smallest the layout allows. Defaults to `value`.
     */
    compactValue?: ReactNode;
  };
  /** Show each slice's value at its legend row's end. Default true. */
  legendValues?: boolean;
  legendColumnsClassName?: string;
  /**
   * The legend view's donut, in pixels or as Recharts' percentage string (a
   * share of the area's smaller half). Default 55% / 85%, the callout view's
   * proportions.
   */
  legendRadii?: { inner: PieRadius; outer: PieRadius };
  /** Height classes of the legend view's chart area. */
  legendAreaClassName?: string;
  /** Forwarded to `ChartLegend`'s `compact` -- a couple of short names rather than a category list. */
  legendCompact?: boolean;
}

/**
 * The help line under a donut widget's View setting. The callout view falls
 * back to the legend where its boxes do not fit, which on a phone is always
 * (boxes on both sides of a donut with a centre figure need about 408px, and a
 * phone's card leaves about 325), so the setting says so rather than offering
 * a choice that silently does nothing there.
 */
export function DonutCalloutViewHint() {
  const t = useTranslations('dashboard');
  return <p className="text-xs text-gray-500 dark:text-gray-400">{t('widgets.viewCalloutsHint')}</p>;
}

interface Size {
  width: number;
  height: number;
}

/**
 * The callout view needs a hole wide enough for the centre figure: a box
 * column that leaves only the smallest donut would squeeze it to a few
 * characters, so a chart with a centre asks for a larger donut and falls back
 * to the legend where that does not fit. At 96 the hole leaves the figure
 * about 95px, which holds a compact total and its partial marker ("$123.5K*")
 * at the figure's size; a dashboard card on a large screen still fits the
 * boxes beside it.
 */
const WITH_CENTER_OPTIONS: Partial<CalloutLayoutOptions> = { minRadius: 96 };

/** Share of the hole's diameter the centre figure may use, keeping it off the ring. */
const CENTER_WIDTH_SHARE = 0.9;

/** The element's content box, once a ResizeObserver has reported it. */
function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const next = { width: Math.floor(rect.width), height: Math.floor(rect.height) };
      setSize((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** A Recharts radius (pixels or a share of the area's smaller half) in pixels. */
function radiusInPixels(radius: PieRadius, size: Size): number {
  if (typeof radius === 'number') return radius;
  return (parseFloat(radius) / 100) * (Math.min(size.width, size.height) / 2);
}

/**
 * A dashboard donut with each slice named either in a box beside the chart and
 * a leader line to its slice, or in a legend under it (Top Recurring Expenses,
 * Expenses by Category).
 *
 * The callout boxes are positioned by `layoutCallouts`, which keeps them apart
 * and inside the measured chart area. Where the area is too small for that,
 * the chart falls back to the legend rather than drawing boxes that collide or
 * spill out of the card. Showing the legend only shrinks the chart area, so
 * the fallback cannot flip back and forth.
 *
 * Both views share the donut's angles (`DEFAULT_CALLOUT_OPTIONS`), so a
 * leader line starts on the slice it names. The centre figure is bounded by
 * the hole it sits in, measured in either view.
 */
export function DonutCalloutChart<T extends DonutCalloutSlice>({
  slices,
  view,
  label,
  formatValue,
  renderTooltip,
  center,
  legendValues = true,
  legendColumnsClassName = 'sm:grid-cols-2',
  legendRadii = { inner: '55%', outer: '85%' },
  legendAreaClassName = 'flex-1 min-h-[240px]',
  legendCompact = false,
}: DonutCalloutChartProps<T>) {
  const [areaRef, size] = useElementSize<HTMLDivElement>();
  const hasCenter = !!center;

  const layout = useMemo(
    () =>
      view === 'callouts' && size
        ? layoutCallouts(
            slices.map((s) => s.value),
            size.width,
            size.height,
            hasCenter ? WITH_CENTER_OPTIONS : {},
          )
        : null,
    [view, size, slices, hasCenter],
  );
  // Until the area is measured the callout view draws only the donut, so a
  // legend does not flash up and vanish again.
  const showLegend = view === 'legend' || (size !== null && layout === null);

  const holeDiameter = layout
    ? 2 * layout.innerRadius
    : size
      ? 2 * radiusInPixels(legendRadii.inner, size)
      : null;

  const tooltip = (
    <Tooltip
      // Above the callout boxes and the centre figure, which are positioned
      // after the chart.
      wrapperStyle={{ zIndex: 10 }}
      content={({ active, payload }) => {
        if (!active || !payload?.length) return null;
        return renderTooltip(payload[0].payload as T);
      }}
    />
  );

  const cells = slices.map((slice) => <Cell key={slice.key} fill={slice.color} />);
  const pieProps = {
    data: slices as T[],
    paddingAngle: DEFAULT_CALLOUT_OPTIONS.paddingAngle,
    startAngle: DEFAULT_CALLOUT_OPTIONS.startAngle,
    endAngle: DEFAULT_CALLOUT_OPTIONS.endAngle,
    dataKey: 'value',
    nameKey: 'name',
    cursor: 'pointer',
    onClick: (_: unknown, index: number) => slices[index]?.onClick?.(),
  } as const;

  const centerFigure = center && (
    <DonutCenterTotal
      label={center.label}
      value={layout ? (center.compactValue ?? center.value) : center.value}
      maxWidth={holeDiameter === null ? undefined : Math.floor(holeDiameter * CENTER_WIDTH_SHARE)}
    />
  );

  const areaHeight = view === 'callouts' ? 'flex-1 min-h-[260px]' : legendAreaClassName;

  return (
    <>
      <div ref={areaRef} data-testid="donut-chart-area" className={`relative ${areaHeight}`}>
        {layout && size ? (
          <>
            {/* Out of the flow like everything else in the area: a chart drawn
                at the measured size and left in the flow would hold the area
                at that size, so it could grow with the card but never shrink. */}
            <div data-testid="donut-chart-plot" className="absolute inset-0">
              <PieChart width={size.width} height={size.height}>
                <Pie
                  {...pieProps}
                  cx={layout.cx}
                  cy={layout.cy}
                  innerRadius={layout.innerRadius}
                  outerRadius={layout.outerRadius}
                >
                  {cells}
                </Pie>
                {tooltip}
              </PieChart>
            </div>
            {centerFigure}
            <svg
              className="pointer-events-none absolute inset-0"
              width={size.width}
              height={size.height}
              aria-hidden="true"
            >
              {layout.callouts.map((callout) => {
                const color = slices[callout.index].color;
                return (
                  <g key={callout.index}>
                    <polyline
                      points={callout.line.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none"
                      stroke={color}
                      strokeWidth={1}
                    />
                    <circle cx={callout.line[0].x} cy={callout.line[0].y} r={2} fill={color} />
                  </g>
                );
              })}
            </svg>
            <ul aria-label={label}>
              {layout.callouts.map((callout) => {
                const slice = slices[callout.index];
                const content = (
                  <>
                    <span className="block truncate font-medium text-gray-900 dark:text-gray-100">
                      {slice.name}
                    </span>
                    <span className="block truncate tabular-nums text-gray-600 dark:text-gray-400">
                      {formatValue(slice.value)}
                    </span>
                  </>
                );
                const boxClass =
                  'flex h-full w-full flex-col justify-center rounded-md border border-gray-200 dark:border-gray-700 border-l-4 px-2 text-left text-xs leading-tight';
                return (
                  <li
                    key={slice.key}
                    className="absolute"
                    style={{
                      left: callout.box.x,
                      top: callout.box.y,
                      width: callout.box.width,
                      height: callout.box.height,
                    }}
                  >
                    {slice.onClick ? (
                      <button
                        type="button"
                        title={slice.name}
                        onClick={slice.onClick}
                        className={`${boxClass} ${HOVER_ROW_ON_CARD} cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500`}
                        style={{ borderLeftColor: slice.color }}
                      >
                        {content}
                      </button>
                    ) : (
                      <div title={slice.name} className={boxClass} style={{ borderLeftColor: slice.color }}>
                        {content}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <div className="absolute inset-0">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    {...pieProps}
                    cx="50%"
                    cy="50%"
                    innerRadius={legendRadii.inner}
                    outerRadius={legendRadii.outer}
                  >
                    {cells}
                  </Pie>
                  {tooltip}
                </PieChart>
              </ResponsiveContainer>
            </div>
            {centerFigure}
          </>
        )}
      </div>
      {showLegend && (
        <ChartLegend
          className="mt-3 flex-shrink-0"
          columnsClassName={legendColumnsClassName}
          compact={legendCompact}
          items={slices.map((slice) => ({
            key: slice.key,
            name: slice.name,
            color: slice.color,
            trailing: legendValues ? formatValue(slice.value) : undefined,
            onClick: slice.onClick ?? (() => {}),
            disabled: !slice.onClick,
          }))}
        />
      )}
    </>
  );
}
