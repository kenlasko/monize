'use client';

import { useEffect, useMemo, useState, type ComponentType, type SVGProps } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ChevronRightIcon, PresentationChartLineIcon, ScaleIcon } from '@heroicons/react/24/outline';
import { SparklesIcon } from '@heroicons/react/20/solid';
import { CARD_CLASS, HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { TriviaFigure, TriviaItem, TriviaTopic } from '@/types/dashboard-trivia';
import { useDashboardTrivia } from './useDashboardTrivia';
import { WidgetHeading } from './widget-meta';

/** How long one fact stays before the next, unless the reader is pointing at it. */
export const TRIVIA_ROTATE_MS = 12_000;

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/**
 * Every state of the card is one height: the sentence scrolls inside a fixed
 * box rather than growing the card, so a long fact never moves the widgets
 * around it. The grid can still stretch it to its row.
 */
const TRIVIA_CARD_CLASS = `${CARD_CLASS} flex flex-col p-3 sm:p-6 min-h-[390px]`;

interface TopicLook {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** The panel's wash, its glow and the figures' highlight. */
  panel: string;
  glow: string;
  medallion: string;
  label: string;
  figure: string;
}

const TOPIC_LOOK: Record<TriviaTopic, TopicLook> = {
  netWorth: {
    icon: ScaleIcon,
    panel: 'from-sky-50 via-white to-indigo-50 dark:from-sky-950/50 dark:via-gray-900 dark:to-indigo-950/50',
    glow: 'bg-sky-300/40 dark:bg-sky-500/20',
    medallion: 'bg-sky-600 text-white shadow-sky-600/30 dark:bg-sky-500',
    label: 'text-sky-700 dark:text-sky-300',
    figure: 'bg-sky-100 text-sky-900 dark:bg-sky-400/15 dark:text-sky-100',
  },
  investments: {
    icon: PresentationChartLineIcon,
    panel: 'from-emerald-50 via-white to-teal-50 dark:from-emerald-950/50 dark:via-gray-900 dark:to-teal-950/50',
    glow: 'bg-emerald-300/40 dark:bg-emerald-500/20',
    medallion: 'bg-emerald-600 text-white shadow-emerald-600/30 dark:bg-emerald-500',
    label: 'text-emerald-700 dark:text-emerald-300',
    figure: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100',
  },
};

/** A sentence as text and figures, each figure by the name it is quoted by. */
type Part = { text: string } | { figure: string };

function splitSentence(template: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    if (match.index > last) parts.push({ text: template.slice(last, match.index) });
    parts.push({ figure: match[1] });
    last = match.index + match[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}

/**
 * The day's trivia about the reader's net worth and investments, one fact at a
 * time: it moves on by itself, and the arrows step through by hand. Each fact
 * wears its topic's colour and picture, its figures picked out in the sentence.
 * Switched off in AI Settings, it says so and links there.
 */
export function TriviaWidget({ isLoading: parentLoading }: { isLoading: boolean }) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  const enabled = usePreferencesStore((s) => s.preferences?.aiTriviaEnabled) !== false;
  const trivia = useDashboardTrivia(enabled && !parentLoading);

  // The server shuffles the list; the minute the page opened is where a reader
  // joins it, so a reload does not always start on the same fact.
  const [start] = useState(() => Math.floor(Date.now() / 60_000));
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = trivia?.items.length ?? 0;

  useEffect(() => {
    if (paused || count < 2) return;
    const id = setInterval(() => {
      // A hidden tab keeps its place.
      if (document.visibilityState !== 'hidden') setStep((n) => n + 1);
    }, TRIVIA_ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, count, step]);

  const formatFigure = useMemo(
    () =>
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
          case 'month':
            return formatChartDate(`${figure.value}-01`, 'MMMM yyyy');
          case 'text':
            return figure.value;
        }
      },
    [formatCurrency, formatNumber, formatPercent, formatChartDate],
  );

  const heading = (
    <WidgetHeading id="trivia" className="mb-4">
      {t('trivia.title')}
    </WidgetHeading>
  );

  if (!enabled) {
    return (
      <div className={TRIVIA_CARD_CLASS}>
        {heading}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t.rich('trivia.off', {
            link: (chunks) => (
              <Link href="/settings/ai" className="text-blue-600 hover:underline dark:text-blue-400">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    );
  }

  if (parentLoading || trivia === null) {
    return (
      <div className={TRIVIA_CARD_CLASS} aria-busy="true">
        {heading}
        <div className="flex-1 w-full rounded-xl animate-pulse skeleton-shimmer bg-gray-200 dark:bg-gray-700" />
      </div>
    );
  }

  if (count === 0) {
    return (
      <div className={TRIVIA_CARD_CLASS}>
        {heading}
        <p className="text-sm text-gray-500 dark:text-gray-400">{t('trivia.empty')}</p>
      </div>
    );
  }

  const index = (((start + step) % count) + count) % count;
  const item: TriviaItem = trivia.items[index];
  const look = TOPIC_LOOK[item.topic];
  const TopicIcon = look.icon;
  const template =
    item.source === 'ai'
      ? item.text
      : // The catalog's sentence with each figure left as its placeholder, to be
        // picked out below the same way as a model's.
        t(
          `trivia.facts.${item.factId}` as Parameters<typeof t>[0],
          Object.fromEntries(Object.keys(trivia.figures).map((name) => [name, `{${name}}`])),
        );

  return (
    <div
      className={TRIVIA_CARD_CLASS}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <WidgetHeading id="trivia">{t('trivia.title')}</WidgetHeading>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {t('trivia.position', { index: index + 1, total: count })}
        </span>
      </div>

      <figure
        data-testid="trivia-card"
        className={`relative flex flex-1 flex-col overflow-hidden rounded-xl bg-gradient-to-br p-5 sm:p-6 ring-1 ring-black/5 dark:ring-white/10 ${look.panel}`}
      >
        {/* Decoration: a soft glow and the topic's picture, large and faint. */}
        <div aria-hidden="true" className={`pointer-events-none absolute -top-16 -left-16 h-48 w-48 rounded-full blur-3xl ${look.glow}`} />
        <TopicIcon
          aria-hidden="true"
          className="pointer-events-none absolute -right-6 -bottom-8 h-44 w-44 text-gray-900/[0.04] dark:text-white/[0.05]"
        />

        <div className="relative flex items-center gap-3">
          <span className={`flex h-11 w-11 items-center justify-center rounded-full shadow-lg ${look.medallion}`}>
            <TopicIcon aria-hidden="true" className="h-6 w-6" />
          </span>
          <span className={`text-xs font-semibold uppercase tracking-[0.12em] ${look.label}`}>
            {t(`trivia.topics.${item.topic}`)}
          </span>
        </div>

        <blockquote
          key={`${index}-${step}`}
          data-testid="trivia-sentence"
          className="relative mt-4 h-0 min-h-[8.5rem] flex-1 overflow-y-auto text-base leading-relaxed font-medium text-gray-800 motion-safe:animate-chart-in dark:text-gray-100 sm:min-h-[7rem] sm:text-lg"
        >
          {splitSentence(template).map((part, i) =>
            'text' in part ? (
              <span key={i}>{part.text}</span>
            ) : trivia.figures[part.figure] ? (
              <span key={i} className={`whitespace-nowrap rounded-md px-1.5 py-0.5 font-semibold ${look.figure}`}>
                {formatFigure(trivia.figures[part.figure])}
              </span>
            ) : (
              <span key={i}>{`{${part.figure}}`}</span>
            ),
          )}
        </blockquote>

        {/* Its line is kept on every fact, so the card does not move between kinds. */}
        <figcaption className="relative mt-4 flex h-4 items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          {item.source === 'ai' && (
            <>
              <SparklesIcon aria-hidden="true" className="h-3.5 w-3.5" />
              {t('trivia.aiGenerated')}
            </>
          )}
        </figcaption>
      </figure>

      {count > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setStep((n) => n - 1)}
            aria-label={t('trivia.previous')}
            title={t('trivia.previous')}
            className={`rounded-full p-1.5 text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-100 ${HOVER_TOOLBAR_BUTTON}`}
          >
            <ChevronLeftIcon aria-hidden="true" className="h-5 w-5" />
          </button>
          {/* One mark per fact, the current one drawn out; decoration beside the count above. */}
          <div aria-hidden="true" className="flex max-w-[70%] flex-wrap justify-center gap-1.5">
            {trivia.items.map((other, i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${
                  i === index ? `w-5 ${TOPIC_LOOK[other.topic].medallion.split(' ')[0]}` : 'w-1.5 bg-gray-300 dark:bg-gray-600'
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setStep((n) => n + 1)}
            aria-label={t('trivia.next')}
            title={t('trivia.next')}
            className={`rounded-full p-1.5 text-gray-500 hover:text-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-100 ${HOVER_TOOLBAR_BUTTON}`}
          >
            <ChevronRightIcon aria-hidden="true" className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
