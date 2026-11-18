'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDownIcon, ArrowUpIcon } from '@heroicons/react/20/solid';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import type { CollapsedHeaderTitle } from '@/store/mobileChromeStore';

/** Tailwind `gap-1` between the text and the caret. */
const CARET_GAP_PX = 4;

const TITLE_TEXT_CLASS = 'text-base font-semibold';

/**
 * The page title (and the dashboard's headline figure) as it reads once it has
 * scrolled behind the header. Hidden from screen readers: the title and figure
 * it repeats are still in the page, and two copies would be read twice.
 * A switcher caret is the exception: it is a control, so it sits beside the
 * hidden text rather than inside it.
 */
export function CollapsedHeaderTitleView({ content }: { content: CollapsedHeaderTitle }) {
  const { title, figure, figurePartial, change } = content;
  if (figure === undefined) return <CollapsedTitleLine content={content} />;

  const ChangeArrow = change?.up ? ArrowUpIcon : ArrowDownIcon;
  return (
    <div
      aria-hidden="true"
      data-testid="collapsed-header-title"
      className="min-w-0 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none xl:hidden"
    >
      <div className="truncate text-xs text-gray-500 dark:text-gray-400">{title}</div>
      <div className="flex items-baseline gap-1.5 text-base font-bold leading-tight text-gray-900 dark:text-gray-50">
        <span className="truncate">
          {figure}
          {figurePartial && <span className="text-amber-600 dark:text-amber-400">*</span>}
        </span>
        {change && (
          <span
            className={`inline-flex flex-shrink-0 items-center text-xs font-semibold ${
              change.up
                ? 'text-green-700 dark:text-green-400'
                : 'text-red-700 dark:text-red-400'
            }`}
          >
            <ChangeArrow className="h-3 w-3" />
            {change.text}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * One line: the title, or "<title> - <context>" when the page is narrowed to
 * something, then the caret that switches it. Where the composed line is wider
 * than the header leaves it, the title is dropped and the context stands alone
 * ("WS Chequing" rather than "Investments - WS Ch..."): what the page is
 * narrowed to is the part the reader cannot see anywhere else on screen.
 */
function CollapsedTitleLine({ content }: { content: CollapsedHeaderTitle }) {
  const t = useTranslations('layout');
  const { title, context, switcher } = content;
  const full = context ? t('pageHeader.collapsedTitleWithContext', { title, context }) : title;

  // Whether `EntitySwitcher` will draw its caret at all: it draws nothing when
  // the only row is the one on screen, unless it lists the current row too.
  const hasCaret =
    !!switcher &&
    (switcher.showCurrent
      ? switcher.items.length > 0
      : switcher.items.some((item) => item.id !== switcher.currentId));

  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const [fullFits, setFullFits] = useState(true);

  // Measured off an invisible copy of the full line, so dropping the title
  // does not change what is measured and the line cannot flip back and forth.
  // The copy and the caret are observed as well as the row, so a change of
  // text, or a caret that appears or changes width, re-measures.
  useEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!context || !row || !measure || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const caret = caretRef.current ? caretRef.current.offsetWidth + CARET_GAP_PX : 0;
      setFullFits(measure.offsetWidth <= row.clientWidth - caret);
    });
    observer.observe(row);
    observer.observe(measure);
    if (caretRef.current) observer.observe(caretRef.current);
    return () => observer.disconnect();
  }, [context, full, hasCaret]);

  const shown = context && !fullFits ? context : full;

  return (
    <div ref={rowRef} className="flex min-w-0 flex-1 items-center gap-1 xl:hidden">
      <div
        aria-hidden="true"
        data-testid="collapsed-header-title"
        className={`relative min-w-0 truncate ${TITLE_TEXT_CLASS} text-gray-900 transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none dark:text-gray-100`}
      >
        {shown}
        {context && (
          <span
            ref={measureRef}
            data-testid="collapsed-header-title-measure"
            className={`invisible absolute left-0 top-0 whitespace-nowrap ${TITLE_TEXT_CLASS}`}
          >
            {full}
          </span>
        )}
      </div>
      {hasCaret && (
        <span ref={caretRef} className="inline-flex flex-shrink-0 items-center">
          <EntitySwitcher {...switcher} />
        </span>
      )}
    </div>
  );
}
