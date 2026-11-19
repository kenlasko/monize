import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { TriviaFigure } from '@/types/dashboard-trivia';

/**
 * Formats a trivia figure in the reader's own number and date format. A kind
 * this build does not know (a newer server) shows its raw value, never an
 * empty chip.
 */
export function useTriviaFigureFormat(): (figure: TriviaFigure) => string {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const formatChartDate = useChartDateFormat();

  return useCallback(
    (figure: TriviaFigure): string => {
      switch (figure.kind) {
        case 'money':
          return formatCurrency(figure.value, figure.currency);
        case 'percent':
          return formatPercent(figure.value, 2);
        case 'multiple':
          return formatNumber(figure.value, 2);
        case 'rate':
          return formatNumber(figure.value, 4);
        case 'count':
          return formatNumber(figure.value, 0);
        case 'month':
          return formatChartDate(`${figure.value}-01`, 'MMMM yyyy');
        case 'text':
          return figure.value;
        case 'date':
          return formatChartDate(figure.value, 'MMMM d, yyyy');
        case 'day':
          return formatChartDate(figure.value, 'EEEE MMMM d');
        case 'days':
          return t('trivia.units.days', {
            count: figure.value,
            value: formatNumber(figure.value, 0),
          });
        case 'years':
          return t('trivia.units.years', {
            count: figure.value,
            value: formatNumber(figure.value, 0),
          });
        default:
          return String((figure as { value: unknown }).value);
      }
    },
    [t, formatCurrency, formatNumber, formatPercent, formatChartDate],
  );
}
