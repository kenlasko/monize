'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { CompareScenariosView } from '@/components/reports/monte-carlo/CompareScenariosView';

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function ComparePageContent() {
  const searchParams = useSearchParams();
  const ids = parseIds(searchParams.get('ids'));

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Compare Monte Carlo Scenarios"
          subtitle="Side-by-side metrics for up to 4 saved scenarios."
          actions={
            <Link href="/reports/monte-carlo-simulation">
              <Button variant="outline">Back to Monte Carlo</Button>
            </Link>
          }
        />
        <CompareScenariosView ids={ids} />
      </main>
    </PageLayout>
  );
}

export default function CompareScenariosPage() {
  return (
    <ProtectedRoute>
      <ComparePageContent />
    </ProtectedRoute>
  );
}
