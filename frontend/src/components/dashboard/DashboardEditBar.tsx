'use client';

import { useTranslations } from 'next-intl';
import { PlusIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { CARD_CLASS } from '@/components/ui/Card';

interface DashboardEditBarProps {
  onAddWidget: () => void;
  onHeroSettings: () => void;
  onReset: () => void;
  onCancel: () => void;
  onDone: () => void;
  /** The draft holds no widget: there is nothing Done could store. */
  doneDisabled: boolean;
  saving: boolean;
}

/**
 * The bar edit mode puts under the pinned header. Its `top` follows the
 * header as it slides away (`--app-header-offset`) and clears an installed
 * app's status bar, as the reconcile page's sticky bar does. On a phone it
 * wraps by the toolbar rule: the actions take the first line and Cancel and
 * Done share the next one.
 */
export function DashboardEditBar({
  onAddWidget,
  onHeroSettings,
  onReset,
  onCancel,
  onDone,
  doneDisabled,
  saving,
}: DashboardEditBarProps) {
  const t = useTranslations('dashboard');
  const tc = useTranslations('common');
  return (
    <div
      role="region"
      aria-label={t('edit.barLabel')}
      data-testid="dashboard-edit-bar"
      className={`${CARD_CLASS} sticky top-[calc(4rem+env(safe-area-inset-top)-var(--app-header-offset,0px))] z-20 mb-6 p-3`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button variant="outline" size="sm" onClick={onAddWidget} disabled={saving}>
            <PlusIcon className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('edit.addWidget')}
          </Button>
          <Button variant="outline" size="sm" onClick={onHeroSettings} disabled={saving}>
            {t('edit.heroSettings')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>
            {t('customize.reset')}
          </Button>
        </div>
        {/* Widths and heights are chosen from `lg` up; one column below. */}
        <p className="w-full text-xs text-gray-500 dark:text-gray-400 sm:w-auto lg:hidden">
          {t('edit.phoneNote')}
        </p>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <Button variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={onCancel} disabled={saving}>
            {tc('cancel')}
          </Button>
          <Button
            size="sm"
            className="flex-1 sm:flex-none"
            onClick={onDone}
            disabled={doneDisabled}
            isLoading={saving}
          >
            {t('edit.done')}
          </Button>
        </div>
      </div>
    </div>
  );
}
