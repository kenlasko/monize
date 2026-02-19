/**
 * Shared color utility functions for budget components.
 * Provides consistent color coding based on budget usage percentages.
 */

/** Text color class based on percentage used */
export function budgetPercentColor(percent: number): string {
  if (percent > 100) return 'text-red-600 dark:text-red-400';
  if (percent > 80) return 'text-amber-600 dark:text-amber-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

/** Progress bar background class based on percentage used */
export function budgetProgressBarColor(percent: number): string {
  if (percent > 100) return 'bg-red-500';
  if (percent > 80) return 'bg-amber-500';
  return 'bg-emerald-500';
}

/** Smaller category bar background class based on percentage used */
export function budgetCategoryBarColor(percent: number): string {
  if (percent > 100) return 'bg-red-400';
  if (percent > 80) return 'bg-amber-400';
  return 'bg-emerald-400';
}

/** Pace status label */
export function paceStatusLabel(paceStatus: 'under' | 'on_track' | 'over'): string {
  switch (paceStatus) {
    case 'under':
      return 'Under budget';
    case 'on_track':
      return 'On track';
    case 'over':
      return 'Over budget';
  }
}

/** Pace status text color class */
export function paceStatusColor(paceStatus: 'under' | 'on_track' | 'over'): string {
  switch (paceStatus) {
    case 'under':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'on_track':
      return 'text-blue-600 dark:text-blue-400';
    case 'over':
      return 'text-red-600 dark:text-red-400';
  }
}
