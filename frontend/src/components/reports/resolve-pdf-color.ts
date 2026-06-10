/**
 * The PDF legend renderer draws swatches with jsPDF, which needs concrete
 * hex values rather than CSS variable references like the chart colour
 * tokens from `@/lib/chart-colors`. Resolve a token against the active
 * theme at export time (the chart image itself is handled by
 * pdf-export-charts inlining computed colours into the captured SVG).
 *
 * Falls back to a neutral gray when the variable resolves to a non-hex
 * colour (e.g. an `oklch()` value from the default Tailwind ramps).
 */
export function resolvePdfColor(color: string): string {
  const varName = color.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (!varName) return color;
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
  return /^#[0-9a-fA-F]{6}$/.test(resolved) ? resolved : '#6b7280';
}
