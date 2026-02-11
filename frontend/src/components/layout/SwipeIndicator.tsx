'use client';

interface SwipeIndicatorProps {
  currentIndex: number;
  totalPages: number;
  isSwipePage: boolean;
}

export function SwipeIndicator({ currentIndex, totalPages, isSwipePage }: SwipeIndicatorProps) {
  if (!isSwipePage) return null;

  return (
    <div className="flex justify-center gap-1.5 py-1.5 md:hidden" aria-hidden="true">
      {Array.from({ length: totalPages }, (_, i) => (
        <div
          key={i}
          className={`rounded-full transition-colors ${
            i === currentIndex
              ? 'w-2 h-2 bg-blue-500 dark:bg-blue-400'
              : 'w-1.5 h-1.5 bg-gray-300 dark:bg-gray-600'
          }`}
        />
      ))}
    </div>
  );
}
