import { chartColors } from './chart-colors';

/**
 * The chart chrome every Recharts chart shares, so the dashboard and the
 * reports read as one system. Colours come from `chartColors`; this file owns
 * the shape around them. `src/test/chart-style.guard.test.ts` holds every
 * `<CartesianGrid>` and every chart tooltip shell to these constants.
 */

/**
 * The grid of a chart whose value axis is vertical (line, area, column
 * charts): horizontal value lines only, finely dashed, in the themed grid
 * colour. Vertical lines against a time axis carry no reading the axis ticks
 * do not already give, and doubled the ink behind every series.
 *
 * `<CartesianGrid {...CHART_GRID_PROPS} />`
 */
export const CHART_GRID_PROPS = {
  strokeDasharray: '3 4',
  stroke: chartColors.grid,
  vertical: false,
} as const;

/**
 * The grid of a horizontal bar chart (`layout="vertical"`), whose value axis
 * runs across: the value lines are vertical, so the grid is too.
 */
export const CHART_GRID_PROPS_HORIZONTAL_BARS = {
  strokeDasharray: '3 4',
  stroke: chartColors.grid,
  horizontal: false,
} as const;

/** Rounded value end of a column (vertical bar). Only the outermost segment of a stack takes it. */
export const CHART_BAR_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

/** Rounded value end of a horizontal bar (`layout="vertical"`). */
export const CHART_BAR_RADIUS_HORIZONTAL: [number, number, number, number] = [0, 4, 4, 0];

/**
 * The shell of a custom Recharts `<Tooltip content>`: the card surface, very
 * slightly translucent over a blur so the series under it stays legible, and
 * in dark mode lit along its top edge like the card it floats over
 * (`shadow-popover-dark` in `globals.css`).
 */
export const CHART_TOOLTIP_CLASS =
  'bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg dark:shadow-popover-dark p-3';
