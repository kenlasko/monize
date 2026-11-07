'use client';

import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { FORECAST_PERIOD_LABELS, FutureTransaction } from '@/lib/forecast';
import { loadFutureTransactions } from '@/lib/future-transactions';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { CashFlowForecastPlot } from '@/components/bills/CashFlowForecastPlot';
import {
  FORECAST_PERIODS,
  asForecastPeriod,
  useCashFlowForecast,
} from '@/components/bills/useCashFlowForecast';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { CASH_FLOW_FORECAST_DEFAULT, CashFlowForecastConfig } from './widget-config';

const WIDGET_ID = 'cash-flow-forecast';

/** Stand-in while the rows load; stable so it does not rebuild the forecast. */
const NO_FUTURE_TRANSACTIONS: FutureTransaction[] = [];

interface CashFlowForecastWidgetProps {
  scheduledTransactions: ScheduledTransaction[];
  accounts: Account[];
  isLoading: boolean;
}

/**
 * The Bills & Deposits page's Cash Flow Forecast on the dashboard. The
 * projection is built by the same hook from the same inputs (the scheduled
 * occurrences, the current balances and the posted future-dated rows), and
 * drawn by the same plot, so the widget and the page cannot disagree about it.
 * The period and the account selection are the widget's own settings.
 */
export function CashFlowForecastWidget({
  scheduledTransactions,
  accounts,
  isLoading,
}: CashFlowForecastWidgetProps) {
  const t = useTranslations('dashboard');
  const tb = useTranslations('bills');
  const { config, updateConfig } = useWidgetConfig<CashFlowForecastConfig>(
    WIDGET_ID,
    CASH_FLOW_FORECAST_DEFAULT,
  );
  // Stored settings are whatever the preference row holds; read each through
  // its shape so a stale value cannot reach the forecast.
  const period = asForecastPeriod(config.period) ?? CASH_FLOW_FORECAST_DEFAULT.period;
  const accountIds = Array.isArray(config.accountIds) ? config.accountIds : [];

  // The current balance excludes posted rows dated after today, so a forecast
  // without them is wrong rather than partial. They are loaded once the
  // dashboard's own data has, and again whenever it reloads, so the balances
  // and the rows layered onto them come from the same moment.
  const untitled = tb('forecast.untitledTransaction');
  const {
    data: futureTransactions,
    isLoading: futureLoading,
    error: futureError,
  } = useReportData(
    () => (isLoading ? Promise.resolve(null) : loadFutureTransactions(untitled)),
    [isLoading, untitled],
  );

  const forecast = useCashFlowForecast({
    accounts,
    scheduledTransactions,
    futureTransactions: futureTransactions ?? NO_FUTURE_TRANSACTIONS,
    period,
    accountIds,
  });

  const configControls = (
    <WidgetConfigRow label={t('widgets.accounts')}>
      <MultiSelect
        ariaLabel={tb('forecast.accountsAriaLabel')}
        placeholder={tb('forecast.allAccounts')}
        options={forecast.accountOptions}
        value={forecast.orderedAccountIds}
        onChange={(ids) => updateConfig({ accountIds: ids })}
      />
    </WidgetConfigRow>
  );

  // No rows and no error is a load not yet started (the render between the
  // dashboard settling and the fetch beginning), not a failure.
  const loading = isLoading || futureLoading || (futureTransactions === null && !futureError);

  return (
    <WidgetCard
      title={t('cashFlowForecast.title')}
      titleHref="/bills"
      widgetId={WIDGET_ID}
      headerRight={
        <WidgetSegmentedControl
          ariaLabel={t('cashFlowForecast.period')}
          value={period}
          onChange={(value) => updateConfig({ period: value })}
          options={FORECAST_PERIODS.map((p) => ({ value: p, label: FORECAST_PERIOD_LABELS[p] }))}
        />
      }
      configControls={configControls}
      configTitle={t('cashFlowForecast.title')}
    >
      {loading ? (
        <div
          data-testid="cash-flow-forecast-widget-loading"
          className="flex-1 min-h-[288px] animate-pulse skeleton-shimmer rounded-md bg-gray-100 dark:bg-gray-700/50"
        />
      ) : futureError ? (
        // Never a forecast without the future-dated rows: it would project
        // from a balance missing them and look complete.
        <WidgetMessage>{t('cashFlowForecast.loadFailed')}</WidgetMessage>
      ) : (
        <CashFlowForecastPlot
          forecast={forecast}
          accounts={accounts}
          scheduledTransactions={scheduledTransactions}
          chartClassName="flex-1"
        />
      )}
    </WidgetCard>
  );
}
