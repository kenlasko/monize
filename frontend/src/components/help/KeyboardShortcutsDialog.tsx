'use client';

import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { TABLE_BODY_CLASS } from '@/components/ui/Table';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';

interface ShortcutRow {
  labelKey: string;
  keysKey: string;
}

/** The global shortcuts, in the order a reader is most likely to reach for them. */
const ROWS: ShortcutRow[] = [
  { labelKey: 'search', keysKey: 'searchKeys' },
  { labelKey: 'undo', keysKey: 'undoKeys' },
  { labelKey: 'redo', keysKey: 'redoKeys' },
  { labelKey: 'closeDialog', keysKey: 'closeDialogKeys' },
];

/**
 * The header Help menu's "Keyboard shortcuts" entry: a short reference for the
 * shortcuts that work from anywhere in the app (`HelpSearchShortcut`'s
 * `Ctrl/Cmd+K` and `?`, `useUndoRedo`'s undo/redo, and `Escape`). Opened only
 * from the menu, so it has no shortcut of its own.
 */
export function KeyboardShortcutsDialog() {
  const t = useTranslations('help.shortcuts');

  return (
    <Modal
      isOpen
      onClose={() => useHelpShortcutsStore.getState().closeShortcuts()}
      title={t('title')}
      maxWidth="sm"
      padding="md"
    >
      <dl className={TABLE_BODY_CLASS}>
        {ROWS.map((row) => (
          <div
            key={row.labelKey}
            className="flex items-center justify-between gap-3 py-2 text-sm"
          >
            <dt className="text-gray-700 dark:text-gray-300">{t(row.labelKey)}</dt>
            <dd className="shrink-0 font-mono text-xs text-gray-500 dark:text-gray-400">
              {t(row.keysKey)}
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
