'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SparklesIcon } from '@heroicons/react/20/solid';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type {
  DashboardTriviaResponse,
  TriviaFigure,
  TriviaItem,
  TriviaTopic,
} from '@/types/dashboard-trivia';

/** How long one sentence stays while the hero itself is not moving. */
export const TRIVIA_ROTATE_MS = 60_000;

const TOPIC_BADGE: Record<TriviaTopic, BadgeVariant> = {
  netWorth: 'blue',
  investments: 'green',
};

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

/**
 * One sentence of the day's list, beside the greeting and above the figures:
 * the facts about the set the hero is showing, or the other set's when
 * it has none. The badge says which of the two it is about.
 */
export function DashboardTrivia({
  trivia,
  topic,
  heroCycling = false,
}: {
  trivia: DashboardTriviaResponse;
  topic: TriviaTopic;
  /** The hero is alternating on its own, so its changes pace the sentences. */
  heroCycling?: boolean;
}) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatNumber, formatPercent } = useNumberFormat();
  const formatChartDate = useChartDateFormat();

  // The server shuffles the list; the minute the page opened is where a reader
  // joins it, so a reload does not always start on the same sentence.
  const [openedMinute] = useState(() => Math.floor(Date.now() / TRIVIA_ROTATE_MS));

  const { items } = trivia;
  const onTopic = items.filter((item) => item.topic === topic);
  const pool = onTopic.length > 0 ? onTopic : items;
  const poolTopic: TriviaTopic | undefined = pool[0]?.topic;

  // Each list keeps its own place, moved once per visit. One counter shared by
  // both would step twice between a topic's visits on Auto, and a list of even
  // length would never show half of its sentences.
  const [places, setPlaces] = useState<Record<TriviaTopic, number>>({ netWorth: 0, investments: 0 });
  const [prevTopic, setPrevTopic] = useState(topic);
  if (prevTopic !== topic) {
    setPrevTopic(topic);
    if (poolTopic) setPlaces((prev) => ({ ...prev, [poolTopic]: prev[poolTopic] + 1 }));
  }

  useEffect(() => {
    if (heroCycling || !poolTopic) return;
    const id = setInterval(
      () => setPlaces((prev) => ({ ...prev, [poolTopic]: prev[poolTopic] + 1 })),
      TRIVIA_ROTATE_MS,
    );
    return () => clearInterval(id);
  }, [heroCycling, poolTopic]);

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

  if (!poolTopic) return null;

  const item: TriviaItem = pool[(openedMinute + places[poolTopic]) % pool.length];

  const figures = Object.fromEntries(
    Object.entries(trivia.figures).map(([name, figure]) => [name, formatFigure(figure)]),
  );
  const sentence =
    item.source === 'ai'
      ? item.text.replace(PLACEHOLDER, (whole, name: string) => figures[name] ?? whole)
      : t(`trivia.facts.${item.factId}` as Parameters<typeof t>[0], figures);

  return (
    // At most four lines, so it never makes the greeting's row taller; a longer
    // sentence ends in an ellipsis and is whole on hover.
    <p
      data-testid="dashboard-trivia"
      title={sentence}
      className="line-clamp-4 text-xs leading-5 text-gray-600 dark:text-gray-300"
    >
      <Badge variant={TOPIC_BADGE[item.topic]} className="mr-1.5">
        {t(`trivia.topics.${item.topic}`)}
      </Badge>
      {sentence}
      {item.source === 'ai' && (
        <SparklesIcon
          title={t('trivia.aiGenerated')}
          className="ml-1.5 inline h-3.5 w-3.5 align-text-bottom text-gray-400 dark:text-gray-500"
        />
      )}
    </p>
  );
}
