'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRightIcon } from '@heroicons/react/24/outline';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ReleaseNotesMarkdown } from './ReleaseNotesMarkdown';
import { TourOfferList } from './TourOfferList';
import { countChanges, sectionStyle, type SectionStyle } from './section-style';
import { TINT_CLASS } from '@/lib/tint-class';
import type { ReleaseNotes, ReleaseNoteSection } from '@/lib/whats-new';

interface WhatsNewModalProps {
  isOpen: boolean;
  notes: ReleaseNotes | null;
  loading?: boolean;
  /** Whether the viewer is signed in — gates the "seen" actions. */
  authenticated: boolean;
  /** Running app version; drives the guided-tour offer list (authenticated only). */
  currentVersion?: string;
  /** Close without changing state (Close, backdrop, Escape). */
  onClose: () => void;
  /**
   * Called when a tour starts from the offer list, so the host can step the
   * modal aside (and bring it back afterwards) rather than plainly close it.
   * Falls back to `onClose`.
   */
  onTourStart?: () => void;
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

interface IndexedSection {
  section: ReleaseNoteSection;
  /** Position in the notes, which the accordion keys are built from. */
  index: number;
  style: SectionStyle;
}

/**
 * Feature sections lead, in document order; fixes, operator notes and credits
 * follow in their own quieter group. Only the first feature opens by default
 * (the first section of all when a release has no feature section), so the
 * dialog opens on the headline rather than as one long scroll.
 */
function groupSections(notes: ReleaseNotes | null): {
  features: IndexedSection[];
  maintenance: IndexedSection[];
  all: string[];
  defaults: string[];
} {
  if (!notes) return { features: [], maintenance: [], all: [], defaults: [] };
  const indexed = notes.sections.map((section, index) => ({
    section,
    index,
    style: sectionStyle(section.heading),
  }));
  const features = indexed.filter((s) => !s.style.maintenance);
  const maintenance = indexed.filter((s) => s.style.maintenance);
  const all = indexed.flatMap(({ section, index }) => [
    sectionKey(index),
    ...section.children.map((_, j) => childKey(index, j)),
  ]);
  const first = features[0] ?? maintenance[0];
  return {
    features,
    maintenance,
    all,
    defaults: first ? [sectionKey(first.index)] : [],
  };
}

const FOCUS_RING =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';

function Chevron({ open, className }: { open: boolean; className: string }) {
  return (
    <ChevronRightIcon
      aria-hidden
      className={`${className} flex-shrink-0 text-gray-400 transition-transform motion-reduce:transition-none ${
        open ? 'rotate-90' : ''
      }`}
    />
  );
}

/** A section's own Markdown and its subsections, each its own disclosure. */
function SectionBody({
  section,
  index,
  expanded,
  toggle,
}: {
  section: ReleaseNoteSection;
  index: number;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
}) {
  return (
    <>
      {section.body && (
        <div className="mb-2 last:mb-0">
          <ReleaseNotesMarkdown content={section.body} />
        </div>
      )}
      {section.children.length > 0 && (
        <div className="space-y-1">
          {section.children.map((child, j) => {
            const ckey = childKey(index, j);
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
                  className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left ${FOCUS_RING}`}
                >
                  <Chevron open={childOpen} className="h-4 w-4" />
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {child.heading}
                  </span>
                </button>
                {childOpen && (
                  <div className="px-3 pb-3 pl-8">
                    <ReleaseNotesMarkdown content={child.body} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export function WhatsNewModal({
  isOpen,
  notes,
  loading = false,
  authenticated,
  currentVersion,
  onClose,
  onTourStart,
  onShowNextLogin,
  onDontShowAgain,
}: WhatsNewModalProps) {
  const t = useTranslations('common');
  const locale = useLocale();
  // The notes are curated Markdown shipped in the image and written in English
  // only, while everything around them is translated. Say so, rather than
  // leaving a reader of another language wondering what went wrong.
  const notesAreForeign = !locale.toLowerCase().startsWith('en');

  const {
    features,
    maintenance,
    all: allKeys,
    defaults,
  } = useMemo(() => groupSections(notes), [notes]);

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
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="4xl"
      pushHistory
      title={
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {t('whatsNew.title')}
          {/* Out of the dialog's accessible name, which stays "What's New";
              the sr-only line at the top of the body reads the version. */}
          {notes && (
            <Badge variant="blue" size="md" aria-hidden>
              {t('whatsNew.versionLabel', { version: notes.version })}
            </Badge>
          )}
        </span>
      }
      padding="md"
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
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

          <div className="flex flex-wrap justify-end gap-2">
            {/* Close leaves the acknowledgement as it was; the two choices
                beside it change it. */}
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('whatsNew.close')}
            </Button>
            {authenticated && onDontShowAgain && (
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
            )}
          </div>
        </div>
      }
    >
      <div>
        {notes && (
          <p className="sr-only">
            {t('whatsNew.versionLabel', { version: notes.version })}
          </p>
        )}
        {notes?.intro && (
          <div className="mb-4">
            <ReleaseNotesMarkdown content={notes.intro} size="lead" />
          </div>
        )}
        {authenticated && currentVersion && (
          <TourOfferList
            currentVersion={currentVersion}
            onStartTour={onTourStart ?? onClose}
          />
        )}
        {notes ? (
          <>
            {notesAreForeign && (
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
                {t('whatsNew.englishOnly')}
              </p>
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

            {features.length > 0 && (
              <div className="space-y-2">
                {features.map(({ section, index, style }) => {
                  const key = sectionKey(index);
                  const open = expanded.has(key);
                  const count = countChanges(section);
                  const { Icon } = style;
                  return (
                    <div
                      key={key}
                      className="rounded-lg border border-gray-200 dark:border-gray-700"
                    >
                      <button
                        type="button"
                        onClick={() => toggle(key)}
                        aria-expanded={open}
                        className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${HOVER_ROW_ON_CARD} ${FOCUS_RING}`}
                      >
                        <span
                          aria-hidden
                          className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md ${style.tint} ${TINT_CLASS}`}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1 font-semibold text-gray-900 dark:text-gray-100">
                          {section.heading}
                        </span>
                        {count > 0 && (
                          <span className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400">
                            {t('whatsNew.changeCount', { count })}
                          </span>
                        )}
                        <Chevron open={open} className="h-5 w-5" />
                      </button>
                      {open && (
                        <div className="px-3 pb-3 sm:pl-13">
                          <SectionBody
                            section={section}
                            index={index}
                            expanded={expanded}
                            toggle={toggle}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {maintenance.length > 0 && (
              <>
                {features.length > 0 && (
                  <h3 className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    {t('whatsNew.otherSections')}
                  </h3>
                )}
                <div className="divide-y divide-gray-200 dark:divide-gray-700 border-y border-gray-200 dark:border-gray-700">
                  {maintenance.map(({ section, index }) => {
                    const key = sectionKey(index);
                    const open = expanded.has(key);
                    return (
                      <div key={key}>
                        <button
                          type="button"
                          onClick={() => toggle(key)}
                          aria-expanded={open}
                          className={`flex w-full items-center gap-2 rounded py-2.5 text-left ${FOCUS_RING}`}
                        >
                          <Chevron open={open} className="h-4 w-4" />
                          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            {section.heading}
                          </span>
                        </button>
                        {open && (
                          <div className="pb-3 pl-6">
                            <SectionBody
                              section={section}
                              index={index}
                              expanded={expanded}
                              toggle={toggle}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
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
    </Modal>
  );
}
