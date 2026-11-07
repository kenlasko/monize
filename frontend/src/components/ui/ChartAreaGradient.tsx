/**
 * The fill under an area series: the series colour fading from its top to
 * nothing at the baseline. Rendered inside the chart's own `<defs>` (never a
 * shared document-level one: chart export serialises each chart's SVG on its
 * own and would lose it), and referenced as `fill={`url(#${id})`}` with
 * `fillOpacity={1}` left at its default.
 *
 * A series that crosses zero needs its stops placed at the zero line instead
 * (`BalanceHistoryChart`, `CashFlowForecastPlot`), so those keep their own.
 */
export function ChartAreaGradient({
  id,
  color,
  opacity = 0.35,
}: {
  id: string;
  color: string;
  opacity?: number;
}) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="5%" stopColor={color} stopOpacity={opacity} />
      <stop offset="95%" stopColor={color} stopOpacity={0} />
    </linearGradient>
  );
}
