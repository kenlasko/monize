'use client';

import { useTranslations } from 'next-intl';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { chartColors } from '@/lib/chart-colors';
import {
  stripBarHeight,
  type UpcomingStrip,
  type UpcomingStripItem,
} from '@/components/dashboard/variants/upcoming-bills-view';
import type { BillsOutlookProps } from './bills-outlook-view';

const BAR_MAX_PX = 44;
const BAR_UNSCALED_PX = 18;

function barHeight(item: UpcomingStripItem, scaleMax: number | null): number {
  return stripBarHeight(item, scaleMax, BAR_MAX_PX, BAR_UNSCALED_PX);
}

/** The in / out strip: deposits rise above the rule, bills hang below it. */
function Strip({ strip }: { strip: UpcomingStrip }) {
  const t = useTranslations('bills');
  const formatChartDate = useChartDateFormat();
  const anyIn = strip.days.some((day) => day.items.some((i) => i.kind === 'deposit'));
  return (
    <div role="img" aria-label={t('outlook.stripLabel')} className="ui-bills-strip grid grid-cols-14 gap-px">
      {strip.days.map((day) => {
        const ins = day.items.filter((i) => i.kind === 'deposit');
        const outs = day.items.filter((i) => i.kind !== 'deposit');
        return (
          <div key={day.date} className="flex min-w-0 flex-col items-center">
            <div className={`flex items-end gap-0.5 ${anyIn ? 'h-12' : 'h-2'}`}>
              {ins.map((item) => (
                <span
                  key={item.id}
                  className="block w-2"
                  style={{ height: barHeight(item, strip.scaleMax), backgroundColor: chartColors.income }}
                />
              ))}
            </div>
            <div className="ui-bills-strip-axis flex h-12 w-full items-start justify-center gap-0.5">
              {outs.map((item) =>
                item.kind === 'bill' ? (
                  <span
                    key={item.id}
                    className="block w-2"
                    style={{ height: barHeight(item, strip.scaleMax), backgroundColor: chartColors.expense }}
                  />
                ) : (
                  <span
                    key={item.id}
                    className="block w-2 border border-gray-400 dark:border-gray-500"
                    style={{ height: barHeight(item, strip.scaleMax) }}
                  />
                ),
              )}
            </div>
            <span
              className={`ui-bills-strip-day mt-1 text-[11px] tabular-nums ${
                day.isToday ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {day.isToday ? t('outlook.today') : formatChartDate(day.date, 'd')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The Classic outlook band: "Next fourteen days" as a ruled section holding
 * the in / out strip, the dashboard's own drawing carried to the full page.
 * Decorative beside the ledger under it, which carries every figure.
 */
export function BillsOutlookClassic({ strip }: BillsOutlookProps) {
  const t = useTranslations('bills');
  return (
    <section aria-labelledby="bills-outlook-title" className="ui-bills-outlook mb-6">
      <div className="ui-section-head">
        <h2 id="bills-outlook-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('outlook.title')}
        </h2>
      </div>
      <Strip strip={strip} />
    </section>
  );
}
