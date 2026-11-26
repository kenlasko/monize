import { CHART_COLOURS, CHART_COLOURS_ASSETS, CHART_COLOURS_LIABILITIES } from '@/lib/chart-colours';
import { chartColors } from '@/lib/chart-colors';
import type { AggregatedDataPoint } from '@/types/custom-report';

/** Chart marks and legend swatches must use the same ordering and sign palette. */
export function colourReportRows(rows: AggregatedDataPoint[], signedPie: boolean) {
  let ordinary = 0;
  let positive = 0;
  let negative = 0;
  return rows.map(row => {
    let color;
    if (!signedPie) {
      color = row.color || CHART_COLOURS[ordinary++ % CHART_COLOURS.length];
    } else if (row.value === null || row.value === 0) {
      color = chartColors.neutral;
    } else if (row.value > 0) {
      color = CHART_COLOURS_ASSETS[positive++ % CHART_COLOURS_ASSETS.length];
    } else {
      color = CHART_COLOURS_LIABILITIES[negative++ % CHART_COLOURS_LIABILITIES.length];
    }
    return { ...row, color };
  });
}
