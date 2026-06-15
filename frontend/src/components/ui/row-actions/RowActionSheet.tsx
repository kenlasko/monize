'use client';

import { Modal } from '@/components/ui/Modal';
import { ActionIcon } from './ActionIcon';
import { TONE_SHEET_ICON_CLASS } from './actionTones';
import { visibleActions, type RowAction } from './rowAction';

export interface RowActionSheetProps {
  isOpen: boolean;
  /** Heading (e.g. the row's name). */
  title: string;
  /** Optional sub-heading (e.g. a date or type). */
  subtitle?: string;
  actions: RowAction[];
  onClose: () => void;
}

/**
 * Standard mobile action sheet shared by every list. Opened by a long-press /
 * right-click on a row (see `useLongPress`). Generalizes the former
 * `TransactionActionSheet`: a `Modal` with a title block and a vertical list of
 * full-width action buttons. Destructive actions get a red row treatment.
 */
export function RowActionSheet({ isOpen, title, subtitle, actions, onClose }: RowActionSheetProps) {
  const shown = visibleActions(actions);

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="sm" className="p-0">
      <div className="py-2">
        <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{title}</p>
          {subtitle && <p className="text-xs text-gray-500 dark:text-gray-400">{subtitle}</p>}
        </div>
        {shown.map((action) => (
          <button
            key={action.key}
            type="button"
            disabled={action.disabled}
            onClick={() => { onClose(); action.onClick(); }}
            className={`w-full px-4 py-3 text-left text-sm flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed ${
              action.destructive
                ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <ActionIcon
              name={action.icon}
              className={`w-4 h-4 shrink-0 ${action.destructive ? '' : TONE_SHEET_ICON_CLASS[action.tone]}`}
            />
            {action.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
