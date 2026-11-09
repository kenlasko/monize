import { PageHeaderSkeleton, TableSkeleton } from '@/components/ui/LoadingSkeleton';

export default function WarrantiesLoading() {
  return (
    <div className="page-ambient-glow min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeaderSkeleton />
        <TableSkeleton rows={10} columns={6} />
      </div>
    </div>
  );
}
