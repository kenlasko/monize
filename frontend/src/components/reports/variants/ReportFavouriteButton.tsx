'use client';

import { useTranslations } from 'next-intl';

const STAR =
  'M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z';

interface ReportFavouriteButtonProps {
  favourite: boolean;
  onToggle: (event: React.MouseEvent) => void;
  className?: string;
}

/**
 * The favourite star as a real button. It is always a SIBLING of the control
 * that opens the report, never inside it, so nothing interactive nests.
 */
export function ReportFavouriteButton({ favourite, onToggle, className = '' }: ReportFavouriteButtonProps) {
  const t = useTranslations('reports');
  const label = favourite ? t('page.removeFavourite') : t('page.addFavourite');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={favourite}
      aria-label={label}
      title={label}
      className={`ui-rep-fav rounded-full p-1.5 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${className}`}
    >
      <svg
        aria-hidden="true"
        className={`h-4 w-4 ${favourite ? 'text-yellow-500' : 'text-gray-400 dark:text-gray-500'}`}
        fill={favourite ? 'currentColor' : 'none'}
        stroke="currentColor"
        viewBox="0 0 20 20"
      >
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={STAR} />
      </svg>
    </button>
  );
}
