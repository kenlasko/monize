'use client';

import { Guilloche } from '@/components/ui/Guilloche';
import { DashboardHeroFrameStandard } from './DashboardHeroFrameStandard';
import type { DashboardHeroFrameProps } from './dashboard-hero-view';

/**
 * The hero in the Folio style: the Standard arrangement set as a statement,
 * the greeting as its date line, a guilloche behind it and a rule under it.
 * The ornament is clipped in a box of its own, so the figures' popovers are not.
 */
export function DashboardHeroFrameFolio(props: DashboardHeroFrameProps) {
  return (
    <DashboardHeroFrameStandard
      {...props}
      className="ui-hero-statement relative mb-9 border-b border-gray-200 pb-9 dark:border-gray-700"
      ornament={
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden max-lg:hidden">
          <Guilloche className="absolute -right-24 -top-36 h-[38rem] w-[38rem] text-blue-600/15 dark:text-blue-400/20" />
        </div>
      }
    />
  );
}
