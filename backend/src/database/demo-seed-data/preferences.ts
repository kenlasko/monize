/**
 * A customised dashboard, to show off sized widgets: a width of a third, half,
 * two thirds or the full 12-column row, and a height floor of auto, compact,
 * standard or tall. Widgets flow left to right in this order, so each comment
 * is a row. A size equal to the widget's default is simply omitted.
 *
 * Ids and presets are those of frontend/src/components/dashboard/
 * widget-registry.tsx and dashboard-layout.ts; `demo-seed-data/preferences.spec.ts`
 * holds them to the allowed values and to every row adding up to 12 columns.
 */
const SIZES: Record<string, { gridWidth: string; gridHeight: string }> = {
  // Row 1: 8 + 4
  "net-worth": { gridWidth: "twoThirds", gridHeight: "tall" },
  "upcoming-bills": { gridWidth: "third", gridHeight: "tall" },
  // Row 2: 4 + 8
  "expenses-pie": { gridWidth: "third", gridHeight: "standard" },
  "income-expenses": { gridWidth: "twoThirds", gridHeight: "standard" },
  // Row 3: 4 + 4 + 4
  "favourite-accounts": { gridWidth: "third", gridHeight: "compact" },
  "warranties-expiring": { gridWidth: "third", gridHeight: "compact" },
  "budget-status": { gridWidth: "third", gridHeight: "compact" },
  // Row 4: 12
  "cash-flow-sankey": { gridWidth: "full", gridHeight: "tall" },
  // Row 5: 6 + 6
  "portfolio-value": { gridWidth: "half", gridHeight: "standard" },
  "top-movers": { gridWidth: "half", gridHeight: "standard" },
  // Row 6: 4 + 4 + 4
  insights: { gridWidth: "third", gridHeight: "compact" },
  "recurring-expenses": { gridWidth: "third", gridHeight: "compact" },
  "credit-utilization-total": { gridWidth: "third", gridHeight: "compact" },
};

export const dashboardWidgets: string[] = Object.keys(SIZES);

export const dashboardWidgetConfig: Record<
  string,
  { gridWidth: string; gridHeight: string }
> = SIZES;

export const demoPreferences = {
  defaultCurrency: "CAD",
  dateFormat: "YYYY-MM-DD",
  numberFormat: "en-CA",
  theme: "system",
  timezone: "America/Toronto",
  notificationEmail: false,
  twoFactorEnabled: false,
  gettingStartedDismissed: true,
  favouriteReportIds: [],
  dashboardWidgets,
  dashboardWidgetConfig,
};
