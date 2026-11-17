'use client';

import { Modal } from '@/components/ui/Modal';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import type { MobileAddChoice } from '@/store/mobileAddActionStore';

interface MobileAddChooserProps {
  /** The page's "New ..." label, which names what the choices create. */
  title: string;
  /** `null` while closed. */
  choices: readonly MobileAddChoice[] | null;
  onClose: () => void;
}

/**
 * The sheet the tab bar's add button opens on a page whose header "new" button
 * is a menu (a brokerage or a cash transaction on Investments): the same
 * choices, as `RowActionSheet`'s list of full-width rows.
 */
export function MobileAddChooser({ title, choices, onClose }: MobileAddChooserProps) {
  return (
    <Modal isOpen={choices !== null} onClose={onClose} maxWidth="sm" title={title}>
      <div className="py-2">
        {(choices ?? []).map((choice) => (
          <button
            key={choice.key}
            type="button"
            onClick={() => {
              onClose();
              choice.run();
            }}
            className={`${HOVER_ROW_ON_CARD} w-full px-4 py-3 text-left text-sm text-gray-700 dark:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500`}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
