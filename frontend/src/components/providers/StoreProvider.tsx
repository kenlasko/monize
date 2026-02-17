'use client';

import { useEffect, useState } from 'react';

interface StoreProviderProps {
  children: React.ReactNode;
}

export function StoreProvider({ children }: StoreProviderProps) {
  const [isHydrated, setIsHydrated] = useState(false);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration flag on mount
  useEffect(() => { setIsHydrated(true); }, []);

  if (!isHydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Loading...</h2>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
