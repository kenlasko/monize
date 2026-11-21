'use client';

import type { CSSProperties, ReactNode } from 'react';
import { CollapsingTitleContext } from '@/hooks/useCollapsingHeaderTitle';
import type { DashboardHeroFrameProps } from './dashboard-hero-view';

/**
 * The hero in the Standard style: the greeting row above the sets, the chart
 * rising beside it. `ornament` and `className` are the Folio style's, which
 * keeps this arrangement and engraves it.
 */
export function DashboardHeroFrameStandard({
  header,
  headRef,
  headSize,
  cycleControls,
  track,
  ornament,
  className = 'mb-6',
}: DashboardHeroFrameProps & { ornament?: ReactNode; className?: string }) {
  return (
    <div
      className={className}
      data-testid="dashboard-hero-root"
      style={{ '--hero-head-h': `${headSize.height}px`, '--hero-figures-min': `${headSize.width}px` } as CSSProperties}
    >
      {ornament}
      <div ref={headRef} className="ui-dash-greeting flex w-max max-w-full items-start gap-2">
        {/* Beside the figures the headline is what collapses into the app
            header, so the greeting does not. */}
        <div className="min-w-0">
          <CollapsingTitleContext.Provider value={false}>{header}</CollapsingTitleContext.Provider>
        </div>
        {/* After the gear and the help mark, on the greeting's line. */}
        {cycleControls}
      </div>
      {track}
    </div>
  );
}
