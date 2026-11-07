'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  ArrowsPointingInIcon,
  ArrowsPointingOutIcon,
  ChevronDownIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { HelpMarkdown, onlineHref } from '@/components/help/HelpMarkdown';
import { HELP_PANEL_WIDTH } from '@/components/help/help-layout';
import { useHelpPage } from '@/hooks/useHelpPage';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useHelpStore } from '@/store/helpStore';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Room left above a heading the panel has scrolled to. */
const SCROLL_PADDING = 8;

const ICON_BUTTON = `rounded-md p-1.5 text-gray-500 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500 dark:text-gray-400 dark:hover:text-gray-200 ${HOVER_ROW_ON_CARD}`;

/**
 * The in-app user guide: a sheet docked at the right edge (a bottom sheet on a
 * phone) showing a page of the guide the backend ships, opened from a page's
 * `?` icon or from Settings > Help.
 *
 * It copies the assistant sheet's behaviour (`AiChatBubble`): Escape steps down
 * a level (expanded, then docked, then closed), an unpinned panel closes when
 * the route changes, and a phone gets a bottom sheet over a scrim. Docked on a
 * desktop it is a non-modal complementary region; as a bottom sheet or expanded
 * it is a dialog that traps focus. It shares the right edge with the assistant,
 * so opening either closes the other (`AiChatBubble` watches the help store).
 *
 * Mounted through `HelpPanelLoader`, so this file and the Markdown renderer load
 * only when the panel opens.
 */
export function HelpPanel() {
  const t = useTranslations('help.panel');
  const locale = useLocale();
  const pathname = usePathname();
  const isMobile = useIsMobile();

  const target = useHelpStore((s) => s.history[s.cursor] ?? null);
  const canGoBack = useHelpStore((s) => s.cursor > 0);
  const canGoForward = useHelpStore((s) => s.cursor < s.history.length - 1);
  const visit = useHelpStore((s) => s.visit);
  const pinned = useHelpStore((s) => s.pinned);
  const expanded = useHelpStore((s) => s.expanded);
  const { navigate, back, forward, close, setPinned, setExpanded } = useHelpStore.getState();

  const { page, error, loading, retry } = useHelpPage(target?.page ?? null);
  const [tocOpen, setTocOpen] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const modal = isMobile || expanded;

  // Close on a route change unless pinned. The route the panel opened on is the
  // baseline, so opening it never counts as a change.
  const routeRef = useRef(pathname);
  useEffect(() => {
    if (routeRef.current === pathname) return;
    routeRef.current = pathname;
    if (!pinned) close();
  }, [pathname, pinned, close]);

  // Focus enters the panel as soon as it opens, whether or not the page has
  // loaded: as a dialog over a scrim (a phone, or expanded) focus left behind
  // the scrim would be unreachable, and the loading and error states are the
  // ones where a reader most needs to find the way out. Once the page arrives
  // the effect below moves focus on to the section.
  //
  // When the panel closes, focus goes back to whatever opened it, but only if
  // the reader was still in the panel or closed it themself (its Close button,
  // Escape or the scrim). Closed by the assistant launcher or a route change,
  // focus belongs to what the reader just used, and stealing it back would pull
  // them out of the assistant they opened.
  const openerRef = useRef<HTMLElement | null>(null);
  const ownCloseRef = useRef(false);
  const focusInsideRef = useRef(false);
  useEffect(() => {
    // Kept across a development remount, which would otherwise record the title.
    openerRef.current ??= document.activeElement as HTMLElement | null;
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      const opener = openerRef.current;
      if ((ownCloseRef.current || focusInsideRef.current) && opener?.isConnected) {
        opener.focus();
      }
    };
  }, []);

  const closeByReader = () => {
    ownCloseRef.current = true;
    close();
  };

  // Escape steps down one level: expanded -> docked -> closed. A dialog on top
  // of the panel (a form opened from the page behind it) keeps its own Escape.
  // Docked, the panel is a non-modal region beside a working page, so Escape
  // is the panel's only while focus is inside it; pressed anywhere else it is
  // meant for the page (a menu, a field). As a dialog (a phone, or expanded) it
  // covers the page and Escape is global.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      if (!modal && !panelRef.current?.contains(active)) return;
      const other = active?.closest('[role="dialog"]');
      if (other && other !== panelRef.current) return;
      if (useHelpStore.getState().expanded) setExpanded(false);
      else {
        ownCloseRef.current = true;
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, setExpanded, modal]);

  // As a dialog the panel keeps Tab inside itself.
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current;
      if (e.key !== 'Tab' || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal]);

  // Expanded, the panel covers the page, so the page behind must not scroll.
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  // Show the target: scroll the panel's own scroller to the section and move
  // focus to its heading. `scrollTop`, never `scrollIntoView`, which scrolls
  // every ancestor too and would move the page behind the panel. The section
  // is looked up inside the scroller, not by `getElementById`, because the page
  // behind may carry an element with the same id.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!page || !target || !scroller) return;
    const section = target.section
      ? Array.from(scroller.querySelectorAll<HTMLElement>('[id]')).find(
          (el) => el.id === target.section,
        )
      : undefined;
    if (section) {
      const offset =
        section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + offset - SCROLL_PADDING);
    } else {
      scroller.scrollTop = 0;
    }
    const focusable = section?.hasAttribute('tabindex') ? section : titleRef.current;
    focusable?.focus({ preventScroll: true });
  }, [page, target, visit]);

  const online = target
    ? onlineHref({ page: page?.slug ?? target.page, section: target.section })
    : onlineHref({ page: 'index' });
  const sheetClass = expanded
    ? 'fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-800'
    : isMobile
      ? 'fixed inset-x-0 bottom-0 z-40 flex h-[75dvh] flex-col rounded-t-2xl border-t border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800'
      : 'fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-800';

  return (
    <>
      {/* Phone only: the bottom sheet covers the page behind a scrim. */}
      {isMobile && !expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          aria-hidden="true"
          onClick={closeByReader}
        />
      )}

      <div
        ref={panelRef}
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal || undefined}
        aria-label={t('title')}
        className={sheetClass}
        style={!isMobile && !expanded ? { width: HELP_PANEL_WIDTH } : undefined}
        onFocus={() => {
          focusInsideRef.current = true;
        }}
        onBlur={(e) => {
          focusInsideRef.current = e.currentTarget.contains(e.relatedTarget as Node | null);
        }}
      >
        <div className="flex items-center gap-1 border-b border-gray-200 px-3 py-2 dark:border-gray-700">
          <button
            type="button"
            onClick={() => back()}
            disabled={!canGoBack}
            aria-label={t('back')}
            title={t('back')}
            className={ICON_BUTTON}
          >
            <ArrowLeftIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => forward()}
            disabled={!canGoForward}
            aria-label={t('forward')}
            title={t('forward')}
            className={ICON_BUTTON}
          >
            <ArrowRightIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <h2
            ref={titleRef}
            tabIndex={-1}
            className="min-w-0 flex-1 truncate rounded-sm px-1 text-sm font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-100"
          >
            {page?.title ?? t('title')}
          </h2>
          <a
            href={online}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('openOnline')}
            title={t('openOnline')}
            className={ICON_BUTTON}
          >
            <ArrowTopRightOnSquareIcon className="h-5 w-5" aria-hidden="true" />
          </a>
          <button
            type="button"
            onClick={() => setPinned(!pinned)}
            aria-pressed={pinned}
            aria-label={pinned ? t('unpin') : t('pin')}
            title={pinned ? t('unpin') : t('pin')}
            className={`${ICON_BUTTON} ${pinned ? 'bg-gray-100 text-blue-600 dark:bg-gray-700 dark:text-blue-400' : ''}`}
          >
            <PinIcon className="h-5 w-5" filled={pinned} />
          </button>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? t('collapse') : t('expand')}
            title={expanded ? t('collapse') : t('expand')}
            className={ICON_BUTTON}
          >
            {expanded ? (
              <ArrowsPointingInIcon className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ArrowsPointingOutIcon className="h-5 w-5" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={closeByReader}
            aria-label={t('close')}
            title={t('close')}
            className={ICON_BUTTON}
          >
            <XMarkIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {page && page.toc.length > 0 && (
          <div className="border-b border-gray-200 px-4 py-2 dark:border-gray-700">
            <button
              type="button"
              onClick={() => setTocOpen((o) => !o)}
              aria-expanded={tocOpen}
              className="flex w-full items-center justify-between rounded-sm text-left text-xs font-medium text-gray-600 focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-300"
            >
              {t('toc.toggle')}
              <ChevronDownIcon
                className={`h-4 w-4 transition-transform motion-reduce:transition-none ${tocOpen ? 'rotate-180' : ''}`}
                aria-hidden="true"
              />
            </button>
            {tocOpen && (
              <nav aria-label={t('toc.label')} className="mt-2 max-h-48 overflow-y-auto">
                <ul className="space-y-0.5">
                  {page.toc.map((entry) => (
                    <li key={entry.id} className={entry.depth === 3 ? 'pl-4' : undefined}>
                      <button
                        type="button"
                        onClick={() => navigate({ page: page.slug, section: entry.id })}
                        className="w-full rounded-sm py-0.5 text-left text-sm text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
                      >
                        {entry.heading}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </div>
        )}

        <div
          ref={scrollerRef}
          tabIndex={0}
          aria-label={page?.title ?? t('title')}
          className="min-h-0 flex-1 scroll-auto overflow-y-auto px-4 py-3 focus-visible:outline-none"
        >
          <div className={expanded ? 'mx-auto max-w-3xl' : undefined}>
            {!locale.startsWith('en') && (
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                {t('englishOnly')}
              </p>
            )}

            {loading && (
              <div role="status">
                <LoadingSpinner text={t('loading')} />
              </div>
            )}

            {error && (
              <div role="alert" className="py-6 text-center">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {t('error.heading')}
                </h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {t('error.body')}
                </p>
                <div className="mt-3 flex items-center justify-center gap-4 text-sm">
                  <button
                    type="button"
                    onClick={retry}
                    className="rounded-sm font-medium text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
                  >
                    {t('error.retry')}
                  </button>
                  <a
                    href={online}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm font-medium text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
                  >
                    {t('openOnline')}
                  </a>
                </div>
              </div>
            )}

            {page && (
              <HelpMarkdown
                markdown={page.markdown}
                toc={page.toc}
                slug={page.slug}
                onlineUrl={page.onlineUrl}
                images={page.images}
                version={page.version}
                onNavigate={navigate}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function PinIcon({ className, filled }: { className?: string; filled: boolean }) {
  return (
    <svg
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 3.75h6l-.75 5.25 3 3.75H6.75l3-3.75L9 3.75zM12 12.75v7.5"
      />
    </svg>
  );
}
