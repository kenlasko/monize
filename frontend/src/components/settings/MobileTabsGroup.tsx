'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { useMobileTabs } from '@/hooks/useMobileTabs';
import {
  BUILT_IN_VIEW_DEFAULTS,
  MOBILE_TAB_LIMIT,
  VIEW_DEFAULT_FIELDS,
  readViewDefault,
  type MobileAddOpens,
  type MobileTabId,
} from '@/lib/view-defaults';
import type { UpdatePreferencesData } from '@/types/auth';

interface MobileTabsGroupProps {
  /** The stored `viewDefaults` preference, untrusted until read. */
  initial: unknown;
  /** PreferencesSection's optimistic write, shared by every control it hosts. */
  commit: (patch: UpdatePreferencesData, revert: () => void) => void;
  className?: string;
}

const NONE = '';
const SLOTS = Array.from({ length: MOBILE_TAB_LIMIT }, (_, index) => index);

/**
 * Picks the tabs on the mobile bar. One select per place on the bar, so the
 * limit is the shape of the control and not an error to explain; More and the
 * add button are not offered because they are always there. The list has no
 * gaps, so a place set to None closes up and the tabs after it move forward.
 *
 * Picking a tab another place already holds swaps the two rather than refusing
 * or showing it twice. The whole list is one value on the wire, so a swap is
 * one save and the bar can never be stored half-way through it.
 *
 * Under the places, what the add button opens where it starts a new
 * transaction: Quick Add or the New Transaction form
 * (`docs/future-plans/quick-add.md`, "The + button setting").
 */
export function MobileTabsGroup({ initial, commit, className }: MobileTabsGroupProps) {
  const t = useTranslations('settings.preferences');
  const tNav = useTranslations('navigation');
  const { options } = useMobileTabs();
  const [tabs, setTabs] = useState<MobileTabId[]>(
    () => readViewDefault(initial, 'mobileTabs') ?? BUILT_IN_VIEW_DEFAULTS.mobileTabs,
  );
  const [addOpens, setAddOpens] = useState<MobileAddOpens>(
    () => readViewDefault(initial, 'mobileAddOpens') ?? BUILT_IN_VIEW_DEFAULTS.mobileAddOpens,
  );

  const changeAddOpens = (picked: string) => {
    const next = VIEW_DEFAULT_FIELDS.mobileAddOpens.find((value) => value === picked);
    // Picking what is already shown is not an edit, and must not toast as one.
    if (next === undefined || next === addOpens) return;
    const previous = addOpens;
    setAddOpens(next);
    commit({ viewDefaults: { mobileAddOpens: next } }, () =>
      setAddOpens((current) => (current === next ? previous : current)),
    );
  };

  const change = (slot: number, picked: string) => {
    const previous = tabs;
    const places: string[] = SLOTS.map((index) => tabs[index] ?? NONE);
    const elsewhere = places.indexOf(picked);
    if (picked !== NONE && elsewhere !== -1) places[elsewhere] = places[slot];
    places[slot] = picked;
    const next = places.filter((id) => id !== NONE) as MobileTabId[];

    if (next.join() === previous.join()) return;
    setTabs(next);
    commit({ viewDefaults: { mobileTabs: next } }, () =>
      setTabs((current) => (current === next ? previous : current)),
    );
  };

  const selectOptions = [
    { value: NONE, label: t('mobileTabs.none') },
    ...options.map((option) => ({ value: option.id, label: tNav(option.labelKey) })),
  ];

  return (
    <div className={className}>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('groups.mobileNavigation')}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('mobileTabs.intro')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {SLOTS.map((slot) => (
          <Select
            key={slot}
            label={t('mobileTabs.slotLabel', { number: slot + 1 })}
            options={selectOptions}
            value={tabs[slot] ?? NONE}
            onChange={(e) => change(slot, e.target.value)}
          />
        ))}
      </div>
      <div className="mt-4">
        <Select
          label={t('mobileTabs.addOpensLabel')}
          options={VIEW_DEFAULT_FIELDS.mobileAddOpens.map((value) => ({
            value,
            label: t(`mobileTabs.addOpensOptions.${value}`),
          }))}
          value={addOpens}
          onChange={(e) => changeAddOpens(e.target.value)}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('mobileTabs.addOpensHelp')}</p>
      </div>
    </div>
  );
}
