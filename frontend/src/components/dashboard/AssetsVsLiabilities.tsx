'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';
import { MonthlyNetWorth } from '@/types/net-worth';
import { useNumberFormat, type NumberFormatters } from '@/hooks/useNumberFormat';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { PartialTotal } from '@/components/ui/PartialTotal';
import {
  assetsFxComplete,
  liabilitiesFxComplete,
  netWorthIsPartial,
  partialTotalFor,
} from '@/lib/net-worth-completeness';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { DonutCalloutChart, DonutCalloutSlice, DonutCalloutViewHint } from './DonutCalloutChart';
import { ASSETS_LIABILITIES_DEFAULT, AssetsLiabilitiesConfig } from './widget-config';

const WIDGET_ID = 'assets-liabilities';

interface AssetsVsLiabilitiesProps {
  data: MonthlyNetWorth[];
  isLoading: boolean;
  /** The request failed: `data` is empty because nothing came back, not because there is no history. */
  error?: boolean;
}

const ASSET_COLOUR = chartColors.income;
const LIABILITY_COLOUR = chartColors.expense;

interface AssetsTooltipProps {
  slice: { name: string; value: number };
  total: number;
  formatCurrency: NumberFormatters['formatCurrency'];
  formatPercent: NumberFormatters['formatPercent'];
}

function AssetsTooltip({ slice, total, formatCurrency, formatPercent }: AssetsTooltipProps) {
  const percentage = total > 0 ? (slice.value / total) * 100 : 0;
  return (
    <ChartTooltipPanel>
      <p className="font-medium text-gray-900 dark:text-gray-100">{slice.name}</p>
      <p className="text-gray-600 dark:text-gray-400">
        {formatCurrency(slice.value)} ({formatPercent(percentage, 1)})
      </p>
    </ChartTooltipPanel>
  );
}

export function AssetsVsLiabilities({ data, isLoading, error = false }: AssetsVsLiabilitiesProps) {
  const t = useTranslations('dashboard');
  const { formatCurrencyCompact: formatCurrency, formatCurrencyTight, formatPercent, defaultCurrency } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<AssetsLiabilitiesConfig>(
    WIDGET_ID,
    ASSETS_LIABILITIES_DEFAULT,
  );

  // The net-worth series carries assets and liabilities per month; the pie
  // reflects the most recent month's split.
  const latest = useMemo(() => (data.length > 0 ? data[data.length - 1] : null), [data]);

  // Each side reads its own flag, falling back to the month's. A side that is a
  // subtotal says so in its name (text, not colour alone); net worth, which is
  // partial when either side is, goes through `PartialTotal`.
  const chartData = useMemo<DonutCalloutSlice[]>(() => {
    if (!latest) return [];
    const partialName = (name: string, complete: boolean | undefined) =>
      complete === false ? t('assetsVsLiabilities.partialName', { name }) : name;
    return [
      {
        key: 'assets',
        name: partialName(t('assetsVsLiabilities.assets'), assetsFxComplete(latest)),
        value: Math.round(latest.assets),
        color: ASSET_COLOUR,
      },
      {
        key: 'liabilities',
        name: partialName(t('assetsVsLiabilities.liabilities'), liabilitiesFxComplete(latest)),
        value: Math.round(latest.liabilities),
        color: LIABILITY_COLOUR,
      },
    ].filter((d) => d.value > 0);
  }, [latest, t]);

  const netWorth = latest ? Math.round(latest.netWorth) : 0;
  const netWorthTotal = partialTotalFor(
    netWorth,
    latest && netWorthIsPartial(latest) ? false : undefined,
    latest?.missingRatePairs,
  );
  const total = chartData.reduce((sum, item) => sum + item.value, 0);
  const netWorthClass = netWorth >= 0 ? undefined : 'text-red-600 dark:text-red-400';

  const configControls = (
    <WidgetConfigRow label={t('widgets.view')}>
      <WidgetSegmentedControl
        value={config.view}
        onChange={(view) => updateConfig({ view })}
        options={[
          { value: 'callouts', label: t('assetsVsLiabilities.viewCallouts') },
          { value: 'legend', label: t('assetsVsLiabilities.viewLegend') },
        ]}
      />
      <DonutCalloutViewHint />
    </WidgetConfigRow>
  );

  return (
    <WidgetCard
      title={t('assetsVsLiabilities.title')}
      titleHref="/reports/net-worth"
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">{t('assetsVsLiabilities.current')}</span>
      }
      configControls={configControls}
      configTitle={t('assetsVsLiabilities.title')}
      minHeightClass="lg:min-h-[500px]"
    >
      {isLoading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      ) : error ? (
        <WidgetMessage>{t('netWorth.loadFailed')}</WidgetMessage>
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('assetsVsLiabilities.empty')}</WidgetMessage>
      ) : (
        <DonutCalloutChart
          slices={chartData}
          view={config.view}
          label={t('assetsVsLiabilities.title')}
          formatValue={(value) => formatCurrency(value)}
          legendAreaClassName="flex-1 min-h-[16rem]"
          // Only ever Assets and Liabilities: the names and their values sit
          // together as a group, the way the pair of pills looked before this
          // widget moved onto the shared donut, rather than the category
          // legend's columns of aligned trailing figures.
          legendCompact
          // Net worth is what the two slices come to, so it belongs in the
          // donut's hole rather than in a row under the chart.
          center={{
            label: t('assetsVsLiabilities.netWorthLabel'),
            value: (
              <PartialTotal total={netWorthTotal} displayCurrency={defaultCurrency}>
                <span className={netWorthClass}>{formatCurrency(netWorth)}</span>
              </PartialTotal>
            ),
            compactValue: (
              <PartialTotal total={netWorthTotal} displayCurrency={defaultCurrency}>
                <span className={netWorthClass}>{formatCurrencyTight(netWorth)}</span>
              </PartialTotal>
            ),
          }}
          renderTooltip={(slice) => (
            <AssetsTooltip
              slice={slice}
              total={total}
              formatCurrency={formatCurrency}
              formatPercent={formatPercent}
            />
          )}
        />
      )}
    </WidgetCard>
  );
}
