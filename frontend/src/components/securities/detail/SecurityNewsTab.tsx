'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowTopRightOnSquareIcon,
  NewspaperIcon,
  PlayCircleIcon,
} from '@heroicons/react/24/outline';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import type { Security, SecurityNewsResult } from '@/types/investment';

interface SecurityNewsTabProps {
  security: Security;
}

/**
 * Headlines filed against the security.
 *
 * Filed by *mention*, not by subject: the provider returns a story for every
 * ticker it lists, so a piece about another company that happens to name this
 * one appears here. The heading says "mentioning" for that reason -- there is no
 * reliable way to filter it, and a list that claims to be about the company
 * while carrying someone else's news is the worse of the two.
 *
 * A list rather than a table: a headline is a sentence, and the other three
 * facts about it are small. Thumbnails come from our own API, so the reader's
 * browser never contacts the publisher.
 */
export function SecurityNewsTab({ security }: SecurityNewsTabProps) {
  const t = useTranslations('securityDetail');
  const relativeTime = useRelativeTime();

  const [news, setNews] = useState<SecurityNewsResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A different security is a new request: it shows as loading from the
  // render that asks for it (the "info from previous render" pattern). The
  // first load needs nothing here, `isLoading` starts true and `error` null.
  const [loadingFor, setLoadingFor] = useState(security.id);
  if (loadingFor !== security.id) {
    setLoadingFor(security.id);
    setIsLoading(true);
    setError(null);
  }

  const load = useCallback(() => {
    // The writes live in the inner function so they run after the request,
    // not during the effect that starts it.
    const run = async () => {
      try {
        const loaded = await investmentsApi.getSecurityNews(security.id);
        setNews(loaded);
      } catch (err) {
        setError(getErrorMessage(err, t('news.loadFailed')));
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [security.id, t]);

  useEffect(() => {
    load();
  }, [load]);

  const card = (children: React.ReactNode) => (
    <div className={`${CARD_CLASS} p-4`}>
      <h3 className="mb-1 text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('news.title', { symbol: security.symbol })}
      </h3>
      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
        {t('news.subject')}
      </p>
      {children}
    </div>
  );

  if (isLoading) {
    return card(
      <div className="flex justify-center py-10">
        <LoadingSpinner />
      </div>,
    );
  }

  if (error) {
    return card(
      <p className="text-sm text-red-600 dark:text-red-400">{error}</p>,
    );
  }

  // Null provider is not an empty feed: the security's quote provider has no
  // news to give, which is a different thing to say.
  if (news?.provider === null) {
    return card(
      <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">
        {t('news.unsupportedProvider')}
      </p>,
    );
  }

  if (!news || news.items.length === 0) {
    return card(
      <div className="py-10 text-center">
        <NewspaperIcon
          className="mx-auto h-10 w-10 text-gray-400 dark:text-gray-500"
          aria-hidden="true"
        />
        <p className="mt-3 font-medium text-gray-900 dark:text-gray-100">
          {t('news.empty.title')}
        </p>
        <p className="mx-auto mt-1 max-w-md text-sm text-gray-500 dark:text-gray-400">
          {t('news.empty.description')}
        </p>
      </div>,
    );
  }

  return card(
    <ul className="divide-y divide-gray-200 dark:divide-gray-700">
      {news.items.map((item) => {
        // Its own ticker is the one the reader is already looking at; naming the
        // others is what tells them a story is not really about this company.
        const others = item.relatedTickers.filter(
          (ticker) => ticker !== security.symbol,
        );
        return (
          <li key={item.id} className="py-3 first:pt-0 last:pb-0">
            <a
              href={item.link}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex gap-3"
            >
              {item.thumbnailUrl && (
                // Fixed box so a missing or slow image never reflows the list.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  className="h-16 w-24 shrink-0 rounded object-cover"
                />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 group-hover:text-blue-600 dark:text-gray-100 dark:group-hover:text-blue-400">
                  {item.type === 'VIDEO' && (
                    <PlayCircleIcon
                      className="mr-1 inline h-4 w-4 align-text-bottom"
                      aria-label={t('news.video')}
                    />
                  )}
                  {item.title}
                  <ArrowTopRightOnSquareIcon
                    className="ml-1 inline h-3 w-3 align-baseline opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden="true"
                  />
                </p>
                <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                  {item.publisher && <span>{item.publisher}</span>}
                  {item.publisher && item.publishedAt && <span> · </span>}
                  {item.publishedAt && (
                    <time dateTime={item.publishedAt}>
                      {relativeTime(item.publishedAt)}
                    </time>
                  )}
                </p>
                {others.length > 0 && (
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                    {t('news.alsoMentions', {
                      tickers: others.slice(0, 4).join(', '),
                    })}
                  </p>
                )}
              </div>
            </a>
          </li>
        );
      })}
    </ul>,
  );
}
