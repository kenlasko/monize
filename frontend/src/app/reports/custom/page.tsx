'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Redirect to main reports page - custom reports are shown there
export default function CustomReportsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/reports');
  }, [router]);

  return null;
}
