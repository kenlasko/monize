'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useHelpPage } from '@/hooks/useHelpPage';
import { highlightMatches } from '@/lib/helpers/highlight-matches';
import { helpApi } from '@/lib/help';
import { useHelpSearchStore } from '@/store/helpSearchStore';
import { useHelpStore } from '@/store/helpStore';

/** Rests before becoming a request, per `in-app-help-search.md`. */
export const HELP_SEARCH_DEBOUNCE_MS = 150;
const RESULT_LIMIT = 10;

interface ListItem {
  page: string;
  section: string | null;
  label: string;
  pageTitle?: string;
  excerpt?: string;
}

/** What one query answered: `results: null` is a request that failed. */
interface Answer {
  key: string;
  results: ListItem[] | null;
}

const optionId = (listId: string, index: number): string => `${listId}-${index}`;

/**
 * `Ctrl/Cmd+K`, `?` outside a field, the help panel's own search button, and
 * (plan 4) the header Help menu all open this. With an empty query it shows
 * the current screen's table of contents (`helpStore.contextPage`); typing
 * searches the whole guide, debounced, with the current screen's sections
 * boosted. Mounted only while open (`HelpSearchShortcut`), like the panel.
 */
export function HelpSearchDialog() {
  const t = useTranslations('help.search');
  const listId = useId();
  const contextPage = useHelpStore((s) => s.contextPage);
  const { page: contextPageData } = useHelpPage(contextPage);

  const [draft, setDraft] = useState('');
  const typed = draft.trim();
  const rested = useDebouncedValue(typed, HELP_SEARCH_DEBOUNCE_MS);
  // Emptying the box applies at once; any other text applies only once it
  // has rested. `rested` already lags at the last value `typed` settled on
  // -- exactly what should still be searched for while newer text is mid
  // debounce -- so nothing here needs its own state (mirrors
  // ReceiptTransactionPicker's search box, minus the state it didn't need).
  const query = typed === '' ? '' : rested;

  const [answer, setAnswer] = useState<Answer | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    // Nothing to ask for an empty query: `current` below already reads as
    // null for it, since no answer is ever stored under the key "".
    if (query === '') return;
    let cancelled = false;
    helpApi
      .search(query, { context: contextPage ?? undefined, limit: RESULT_LIMIT })
      .then(
        (res) => {
          if (cancelled) return;
          setAnswer({
            key: query,
            results: res.results.map((r) => ({
              page: r.page,
              section: r.section,
              label: r.heading || r.pageTitle,
              pageTitle: r.pageTitle,
              excerpt: r.excerpt,
            })),
          });
        },
        () => {
          if (!cancelled) setAnswer({ key: query, results: null });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [query, contextPage]);

  const current = answer && answer.key === query ? answer : null;
  const failed = current !== null && current.results === null;

  const items: ListItem[] =
    query === ''
      ? (contextPageData?.toc ?? []).map((entry) => ({
          page: contextPage ?? '',
          section: entry.id,
          label: entry.heading,
        }))
      : current?.results ?? [];

  // The active option follows the list it is drawn from, and resets to the
  // top whenever the list itself changes (a new query settled, or the
  // context page's toc arrived) -- adjusted during render, the "info from
  // previous render" pattern, rather than in an effect.
  const resultsKey = `${query}:${items.length}`;
  const [activeResultsKey, setActiveResultsKey] = useState(resultsKey);
  if (activeResultsKey !== resultsKey) {
    setActiveResultsKey(resultsKey);
    setActive(0);
  }

  const terms = query === '' ? [] : query.split(/\s+/).filter(Boolean);

  function choose(item: ListItem) {
    useHelpSearchStore.getState().closeSearch();
    useHelpStore.getState().openAt({ page: item.page, section: item.section ?? undefined });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[active];
      if (item) choose(item);
    }
  }

  return (
    <Modal
      isOpen
      onClose={() => useHelpSearchStore.getState().closeSearch()}
      title={t('title')}
      maxWidth="lg"
      padding="md"
    >
      <div className="space-y-3">
        <div className="relative">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            type="search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={items.length > 0 ? optionId(listId, active) : undefined}
            aria-autocomplete="list"
            aria-label={t('ariaLabel')}
            placeholder={t('placeholder')}
            maxLength={200}
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            className="w-full rounded-md border border-gray-300 bg-white py-2 pl-10 pr-3 text-sm text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
          />
        </div>

        {query === '' ? (
          contextPage &&
          items.length > 0 && (
            <p className="px-1 text-xs font-medium text-gray-500 dark:text-gray-400">
              {t('contextHeading')}
            </p>
          )
        ) : current === null ? (
          <LoadingSpinner />
        ) : failed ? (
          <p role="alert" className="px-1 text-sm text-red-600 dark:text-red-400">
            {t('error')}
          </p>
        ) : (
          items.length === 0 && (
            <p className="px-1 text-sm text-gray-500 dark:text-gray-400">{t('noResults', { query })}</p>
          )
        )}
        <HelpSearchResultList id={listId} items={items} active={active} terms={terms} onChoose={choose} />

        <p className="px-1 text-xs text-gray-400 dark:text-gray-500">
          <kbd>&uarr;</kbd> <kbd>&darr;</kbd> {t('hint.navigate')} &middot; <kbd>Enter</kbd>{' '}
          {t('hint.select')} &middot; <kbd>Esc</kbd> {t('hint.close')}
        </p>
      </div>
    </Modal>
  );
}

interface HelpSearchResultListProps {
  id: string;
  items: readonly ListItem[];
  active: number;
  terms: readonly string[];
  onChoose: (item: ListItem) => void;
}

function HelpSearchResultList({ id, items, active, terms, onChoose }: HelpSearchResultListProps) {
  if (items.length === 0) return null;
  return (
    <ul id={id} role="listbox" className="max-h-80 space-y-0.5 overflow-y-auto">
      {items.map((item, index) => (
        <li
          key={`${item.page}#${item.section ?? ''}`}
          id={optionId(id, index)}
          role="option"
          aria-selected={index === active}
          ref={(element) => {
            if (index === active) element?.scrollIntoView?.({ block: 'nearest' });
          }}
          // Focus stays in the search box; a click must not blur it.
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(item);
          }}
          className={`cursor-pointer rounded-md px-3 py-2 text-sm ${
            index === active
              ? 'bg-blue-50 text-gray-900 dark:bg-blue-900/30 dark:text-gray-100'
              : `text-gray-800 dark:text-gray-200 ${HOVER_ROW_ON_CARD}`
          }`}
        >
          {item.pageTitle && item.pageTitle !== item.label && (
            <div className="text-xs text-gray-500 dark:text-gray-400">{item.pageTitle}</div>
          )}
          <div className="font-medium">{item.label}</div>
          {item.excerpt && (
            <div className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">
              {highlightMatches(item.excerpt, terms).map((segment, i) =>
                segment.match ? (
                  <mark key={i} className="rounded-sm bg-yellow-200 text-gray-900 dark:bg-yellow-500/40 dark:text-gray-100">
                    {segment.text}
                  </mark>
                ) : (
                  <span key={i}>{segment.text}</span>
                ),
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
