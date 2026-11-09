'use client';

import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { COMMAND_GROUPS, commandTerms, highlightFolded } from '@/lib/command-palette';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useCommandItems, type CommandItem } from './useCommandItems';

const KBD_CLASS =
  'inline-flex min-w-5 items-center justify-center rounded border border-gray-300 px-1.5 py-0.5 font-sans text-[11px] leading-none text-gray-500 dark:border-gray-600 dark:text-gray-400';

const optionId = (listId: string, id: string): string => `${listId}-${id}`;

function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {highlightFolded(text, terms).map((segment, i) =>
        segment.match ? (
          <mark key={i} className="rounded-sm bg-yellow-200 text-gray-900 dark:bg-yellow-500/40 dark:text-gray-100">
            {segment.text}
          </mark>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  );
}

function Hint({ keys, label }: { keys: ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys}
      <span>{label}</span>
    </span>
  );
}

/**
 * `Ctrl/Cmd+K` from anywhere: one box over accounts, payees, categories, bills,
 * securities, reports, pages, transactions and the guide. Focus stays in the
 * box; the arrows move an active row (`aria-activedescendant`), Tab jumps to
 * the actions, Enter runs the row. Mounted only while open.
 */
export function CommandPalette() {
  const t = useTranslations('navigation.commandPalette');
  const listId = useId();
  const [draft, setDraft] = useState('');
  const query = draft.trim();
  const { items, pending, failed } = useCommandItems(query);

  // Held by id, not index: a late answer from the server adds rows, and that
  // must not move the highlight off the row the reader is on.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === activeId));
  const active: CommandItem | undefined = items[activeIndex];

  const terms = commandTerms(query);
  const close = () => useCommandPaletteStore.getState().closePalette();

  function choose(item: CommandItem) {
    close();
    item.run();
  }

  // Only a key press scrolls: a late server answer must not pull back a list
  // the reader scrolled, and a hovered row must not move under the pointer.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollPending = useRef(false);
  const activeOptionId = active ? optionId(listId, active.id) : undefined;
  useEffect(() => {
    if (!scrollPending.current || !activeOptionId) return;
    scrollPending.current = false;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeOptionId]);

  function activateByKey(id: string) {
    if (id === active?.id) return;
    scrollPending.current = true;
    setActiveId(id);
  }

  function moveBy(delta: number) {
    if (items.length === 0) return;
    activateByKey(items[(activeIndex + delta + items.length) % items.length].id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // These keys belong to the input method while it is composing text.
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveBy(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveBy(-1);
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const item = items.find((candidate) => candidate.shortcut);
      if (item) choose(item);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose(active);
    } else if (event.key === 'Tab') {
      // Always claimed: the box is the palette's only stop, and Tab's job here
      // is the jump the footer advertises. Tab from the actions goes back up.
      // Stopped too, or Modal's document-level focus trap moves focus to `esc`.
      event.preventDefault();
      event.stopPropagation();
      const inActions = active?.group === 'actions';
      const target = event.shiftKey || inActions ? items[0] : items.find((item) => item.group === 'actions');
      if (target) activateByKey(target.id);
    }
  }

  return (
    <Modal isOpen onClose={close} title={t('title')} titleHidden maxWidth="2xl" anchorTop>
      {/* All the keyboard handling is on the box, so a press anywhere else in
          the palette must not take focus from it. */}
      <div
        className="flex max-h-[calc(96dvh-1rem)] flex-col"
        onMouseDown={(event) => {
          if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
        }}
      >
      <div className="flex items-center gap-2 border-b border-gray-200 pr-3 dark:border-gray-700">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
            aria-hidden="true"
          />
          <input
            type="search"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeOptionId}
            aria-autocomplete="list"
            aria-label={t('title')}
            placeholder={t('placeholder')}
            maxLength={200}
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setActiveId(null);
              listRef.current?.scrollTo?.({ top: 0 });
            }}
            onKeyDown={onKeyDown}
            // The `!`s: the unlayered form rules in globals.css outrank a plain utility.
            className="w-full border-0! bg-transparent! py-4! pl-12! pr-3! text-base! text-gray-900 shadow-none! outline-none! ring-0! dark:text-gray-100 [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        <button type="button" onClick={close} className={KBD_CLASS} aria-label={t('close')}>
          esc
        </button>
      </div>

      <div ref={listRef} id={listId} role="listbox" aria-label={t('title')} className="min-h-0 flex-1 overflow-y-auto p-2">
        {COMMAND_GROUPS.map((group) => {
          const rows = items.filter((item) => item.group === group);
          if (rows.length === 0) return null;
          const headingId = `${listId}-${group}`;
          return (
            <div key={group} role="group" aria-labelledby={headingId} className="mb-2">
              <div
                id={headingId}
                className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
              >
                {t(`groups.${group}`)}
              </div>
              {rows.map((item) => {
                const isActive = item.id === active?.id;
                return (
                  <div
                    key={item.id}
                    id={optionId(listId, item.id)}
                    role="option"
                    aria-selected={isActive}
                    onMouseMove={() => {
                      if (!isActive) setActiveId(item.id);
                    }}
                    onClick={() => choose(item)}
                    className={`flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 ${
                      isActive
                        ? 'bg-blue-50 ring-1 ring-inset ring-blue-200 dark:bg-blue-900/30 dark:ring-blue-700/60'
                        : HOVER_ROW_ON_CARD
                    }`}
                  >
                    {item.visual}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        <Highlighted text={item.label} terms={terms} />
                      </div>
                      {item.detail && (
                        <div className="truncate text-xs text-gray-500 dark:text-gray-400">{item.detail}</div>
                      )}
                    </div>
                    {item.trailing && (
                      <span className="shrink-0 text-sm tabular-nums text-gray-700 dark:text-gray-300">
                        {item.trailing}
                      </span>
                    )}
                    {item.shortcut && <kbd className={KBD_CLASS}>{t('newTransactionShortcut')}</kbd>}
                    {isActive && <kbd className={KBD_CLASS}>&crarr;</kbd>}
                  </div>
                );
              })}
            </div>
          );
        })}
        {items.length === 0 && !pending && (
          <p className="px-2 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('noResults', { query })}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <Hint
          keys={
            <>
              <kbd className={KBD_CLASS}>&uarr;</kbd>
              <kbd className={KBD_CLASS}>&darr;</kbd>
            </>
          }
          label={t('hint.navigate')}
        />
        <Hint keys={<kbd className={KBD_CLASS}>&crarr;</kbd>} label={t('hint.open')} />
        <Hint keys={<kbd className={KBD_CLASS}>tab</kbd>} label={t('hint.actions')} />
        {failed ? (
          <span role="alert" className="ml-auto text-red-600 dark:text-red-400">
            {t('loadFailed')}
          </span>
        ) : (
          <span className="ml-auto hidden sm:inline">{pending ? t('searching') : t('scope')}</span>
        )}
      </div>
      </div>
    </Modal>
  );
}
