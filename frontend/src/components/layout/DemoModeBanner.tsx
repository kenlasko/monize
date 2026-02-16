'use client';

import { useDemoMode } from '@/hooks/useDemoMode';

export function DemoModeBanner() {
  const isDemoMode = useDemoMode();

  if (!isDemoMode) return null;

  return (
    <div className="bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 px-4 py-2 text-center text-sm text-amber-800 dark:text-amber-200">
      <span className="font-semibold">Demo Mode</span>
      {' \u2014 '}
      All data resets daily at 4:00 AM UTC. Explore freely!
    </div>
  );
}
