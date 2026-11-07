import { describe, it, expect } from 'vitest';

/**
 * Guard test for the loading-placeholder sweep (`skeleton-shimmer` in
 * `src/app/globals.css`).
 *
 * A loading placeholder wears `animate-pulse skeleton-shimmer`: the sweep runs
 * where motion is welcome and replaces the pulse, the pulse remains under
 * reduced motion, and tests keep finding a loading state by `.animate-pulse`.
 * `Skeleton` already does; a placeholder written by hand must add the class
 * itself, or it blinks while the rest of the page sweeps.
 *
 * Not every pulse is a placeholder. The files below pulse a live indicator,
 * where a sweep would be wrong, and are the only ones allowed a bare pulse.
 *
 * Modelled on `src/test/ui-conventions.test.ts`.
 */
const sources = import.meta.glob('/src/**/*.tsx', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/** Pulses that signal something live rather than content on its way. */
const LIVE_INDICATORS: Record<string, string> = {
  '/src/components/ai/RelayStatusBar.tsx': 'the relay "listening" status dot',
  '/src/components/settings/ai/ProviderConfigForm.tsx': 'the relay "listening" status dot',
  '/src/components/settings/ai/ProviderList.tsx': 'the relay "listening" status dot',
  '/src/components/ai/ChatMessage.tsx': 'the streaming-reply typing cursor',
  '/src/components/securities/BondRefreshProgress.tsx': 'an indeterminate progress bar',
};

function productionSources(): [string, string][] {
  return Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));
}

const BARE_PULSE = /animate-pulse(?! skeleton-shimmer)/;

describe('loading placeholders sweep rather than blink', () => {
  it('pairs every placeholder pulse with skeleton-shimmer', () => {
    const offenders = productionSources()
      .filter(([path]) => !(path in LIVE_INDICATORS))
      .filter(([, content]) => BARE_PULSE.test(content))
      .map(([path]) => path);
    // Write `animate-pulse skeleton-shimmer`, or use <Skeleton>. A live
    // indicator that should pulse goes in LIVE_INDICATORS with its reason.
    expect(offenders).toEqual([]);
  });

  it('lists only files that still pulse a live indicator', () => {
    const stale = Object.keys(LIVE_INDICATORS).filter(
      (path) => !sources[path] || !BARE_PULSE.test(sources[path]),
    );
    expect(stale).toEqual([]);
  });

  it('still finds the Skeleton primitive wearing the sweep, so the rule cannot pass by accident', () => {
    expect(sources['/src/components/ui/LoadingSkeleton.tsx']).toContain('animate-pulse skeleton-shimmer');
  });
});
