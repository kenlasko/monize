'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import type { HeroNextUp } from './dashboard-hero-view';

const PILL =
  'inline-flex h-12 items-center rounded-full px-5 font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 focus-visible:ring-offset-blue-300 dark:focus-visible:ring-offset-blue-400';

/**
 * The Pebble hero's accent card: the next scheduled occurrence, its amount
 * set large, and the way to record it. The accent is a fill under dark ink in
 * both modes (the companion palette's lime; any palette's light accent step).
 */
export function HeroNextUpCard({ nextUp }: { nextUp: HeroNextUp }) {
  const t = useTranslations('dashboard');
  const formatChartDate = useChartDateFormat();
  const headingId = `hero-next-up-${nextUp.id}`;
  return (
    <section
      aria-labelledby={headingId}
      className="ui-nextup flex min-w-0 flex-[1_1_18rem] flex-col gap-1.5 rounded-[28px] bg-blue-300 p-7 text-gray-900 dark:bg-blue-400"
    >
      <h2 id={headingId} className="font-sans text-sm font-semibold tracking-normal sm:text-base">
        {t('hero.nextUp.heading', { when: nextUp.when, date: formatChartDate(nextUp.dueDate, 'MMM d') })}
      </h2>
      <p className="ui-display-figure mt-2.5 text-[34px] font-bold leading-[1.05] tracking-tight">{nextUp.name}</p>
      <p className="text-gray-900/75">
        {nextUp.payee
          ? t('hero.nextUp.metaWithPayee', { payee: nextUp.payee, manual: String(nextUp.manual) })
          : t('hero.nextUp.meta', { manual: String(nextUp.manual) })}
      </p>
      <p className="ui-display-figure mt-auto pt-6 text-6xl font-bold leading-none tracking-tight">
        {nextUp.amount === null ? (
          <UnknownAmount />
        ) : (
          <MoneyFigure amount={Math.abs(nextUp.amount)} currencyCode={nextUp.currencyCode} display />
        )}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/bills?postBillId=${encodeURIComponent(nextUp.id)}`}
          className={`${PILL} bg-gray-900 text-gray-50 hover:bg-gray-800`}
        >
          {t('hero.nextUp.record', { kind: nextUp.kind })}
        </Link>
        <Link href="/bills" className={`${PILL} border-2 border-gray-900 hover:bg-gray-900/10`}>
          {t('upcomingBills.scope.all')}
        </Link>
      </div>
    </section>
  );
}
