'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';
import { TourOfferList } from './TourOfferList';
import type { ReleaseNotes } from '@/lib/whats-new';

interface WhatsNewModalProps {
  isOpen: boolean;
  notes: ReleaseNotes | null;
  loading?: boolean;
  /** Whether the viewer is signed in — gates the "seen" actions. */
  authenticated: boolean;
  /** Running app version; drives the guided-tour offer list (authenticated only). */
  currentVersion?: string;
  /** Close without changing state (X, backdrop, Escape). */
  onClose: () => void;
  /**
   * Clear the acknowledgement so the digest shows again next login ("Show at
   * next login"). Only when authenticated; falls back to a plain close.
   */
  onShowNextLogin?: () => void;
  /** Acknowledge the version ("Don't show this again"). Only when authenticated. */
  onDontShowAgain?: () => void;
}

const sectionKey = (i: number) => `s${i}`;
const childKey = (i: number, j: number) => `s${i}.c${j}`;

/** All accordion keys, plus the subset expanded by default (top-level sections). */
function collectKeys(notes: ReleaseNotes | null): {
  all: string[];
  defaults: string[];
} {
  if (!notes) return { all: [], defaults: [] };
  const all: string[] = [];
  const defaults: string[] = [];
  notes.sections.forEach((section, i) => {
    const sk = sectionKey(i);
    all.push(sk);
    defaults.push(sk);
    section.children.forEach((_, j) => all.push(childKey(i, j)));
  });
  return { all, defaults };
}

export function WhatsNewModal({
  isOpen,
  notes,
  loading = false,
  authenticated,
  currentVersion,
  onClose,
  onShowNextLogin,
  onDontShowAgain,
}: WhatsNewModalProps) {
  const t = useTranslations('common');

  const { all: allKeys, defaults } = useMemo(() => collectKeys(notes), [notes]);

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(defaults),
  );

  // Reset the accordion to its default (sections open, details collapsed)
  // whenever the notes change, using the "info from previous render" pattern so
  // we avoid setState-in-effect.
  const [trackedVersion, setTrackedVersion] = useState(notes?.version);
  if (notes?.version !== trackedVersion) {
    setTrackedVersion(notes?.version);
    setExpanded(new Set(defaults));
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const allExpanded =
    allKeys.length > 0 && allKeys.every((k) => expanded.has(k));

  const toggleAll = () =>
    setExpanded(allExpanded ? new Set() : new Set(allKeys));

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="4xl" pushHistory>
      <div className="flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('whatsNew.title')}
            </h2>
            {notes && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('whatsNew.versionLabel', { version: notes.version })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('whatsNew.close')}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 py-4">
          {authenticated && currentVersion && (
            <TourOfferList currentVersion={currentVersion} onClose={onClose} />
          )}
          {notes ? (
            <>
              {notes.intro && (
                <div className="mb-4">
                  <ReleaseNotesMarkdown content={notes.intro} />
                </div>
              )}

              {notes.sections.length > 0 && (
                <div className="mb-2 flex justify-end">
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline focus:outline-none focus-visible:underline"
                  >
                    {allExpanded
                      ? t('whatsNew.collapseAll')
                      : t('whatsNew.expandAll')}
                  </button>
                </div>
              )}

              <div className="divide-y divide-gray-200 dark:divide-gray-700 border-y border-gray-200 dark:border-gray-700">
                {notes.sections.map((section, i) => {
                  const key = sectionKey(i);
                  const open = expanded.has(key);
                  return (
                    <div key={key}>
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={open}
                        className="flex w-full items-center gap-2 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                      >
                        <ChevronRightIcon
                          className={`h-5 w-5 flex-shrink-0 text-gray-400 transition-transform ${
                            open ? 'rotate-90' : ''
                          }`}
                        />
                        <span className="font-semibold text-gray-900 dark:text-gray-100">
                          {section.heading}
                        </span>
                      </button>

                      {open && (
                        <div className="pb-3 pl-7">
                          {section.body && (
                            <div className="mb-2">
                              <ReleaseNotesMarkdown content={section.body} />
                            </div>
                          )}

                          {section.children.length > 0 && (
                            <div className="space-y-1">
                              {section.children.map((child, j) => {
                                const ckey = childKey(i, j);
                                const childOpen = expanded.has(ckey);
                                return (
                                  <div
                                    key={ckey}
                                    className="rounded border border-gray-100 dark:border-gray-700/60"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => toggle(ckey)}
                                      aria-expanded={childOpen}
                                      className="flex w-full items-center gap-2 px-2 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
                                    >
                                      <ChevronRightIcon
                                        className={`h-4 w-4 flex-shrink-0 text-gray-400 transition-transform ${
                                          childOpen ? 'rotate-90' : ''
                                        }`}
                                      />
                                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                                        {child.heading}
                                      </span>
                                    </button>
                                    {childOpen && (
                                      <div className="px-3 pb-3 pl-8">
                                        <ReleaseNotesMarkdown
                                          content={child.body}
                                        />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          ) : loading ? (
            <div className="py-8">
              <LoadingSpinner />
            </div>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400 py-4">
              {t('whatsNew.unavailable')}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700">
          {notes ? (
            <a
              href={notes.releaseUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              {t('whatsNew.viewFullNotes')}
            </a>
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            {authenticated && onDontShowAgain ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onShowNextLogin ?? onClose}
                >
                  {t('whatsNew.showNextLogin')}
                </Button>
                <Button variant="primary" size="sm" onClick={onDontShowAgain}>
                  {t('whatsNew.dontShowAgain')}
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" onClick={onClose}>
                {t('whatsNew.close')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
