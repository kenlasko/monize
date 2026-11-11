/**
 * The wash and glyph colour of a tinted icon puck, read from `--widget-tint`,
 * which the caller sets to a chart token (`[--widget-tint:var(--chart-5)]`) so
 * a palette recolours the puck with everything else. Shared by the dashboard
 * widget headers and the What's New section rows.
 *
 * The tokens are pitched for a line on a card, so on a light tile the glyph is
 * darkened: amber at full strength would be barely visible on its own wash.
 */
export const TINT_CLASS =
  'bg-[color-mix(in_srgb,var(--widget-tint)_14%,transparent)] text-[color-mix(in_srgb,var(--widget-tint)_75%,black)] dark:bg-[color-mix(in_srgb,var(--widget-tint)_20%,transparent)] dark:text-[var(--widget-tint)]';
