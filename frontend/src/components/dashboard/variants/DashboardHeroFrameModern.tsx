'use client';

import { CollapsingTitleContext } from '@/hooks/useCollapsingHeaderTitle';
import { HeroNextUpCard } from './HeroNextUpCard';
import type { DashboardHeroFrameProps } from './dashboard-hero-view';

/**
 * The hero in the Modern style: the greeting across the page, then the sets
 * in one inverted block (`ui-invert` turns the gray ramp around inside it, so
 * either set draws there unchanged) beside the next-up card.
 */
export function DashboardHeroFrameModern({ header, cycleControls, track, nextUp }: DashboardHeroFrameProps) {
  return (
    <div className="mb-4" data-testid="dashboard-hero-root">
      <div className="ui-dash-greeting flex items-end gap-2 px-1 pt-3 pb-5">
        <div className="min-w-0 flex-1">
          <CollapsingTitleContext.Provider value={false}>{header}</CollapsingTitleContext.Provider>
        </div>
        {cycleControls}
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="ui-invert min-w-0 flex-[3_1_40rem] rounded-[28px] bg-white p-6 text-gray-900 sm:p-8 dark:bg-gray-800 dark:text-gray-100">
          {track}
        </div>
        {nextUp && <HeroNextUpCard nextUp={nextUp} />}
      </div>
    </div>
  );
}
