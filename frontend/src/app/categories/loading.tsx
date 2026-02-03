import { PageHeaderSkeleton, TableSkeleton } from '@/components/ui/LoadingSkeleton';

export default function CategoriesLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <PageHeaderSkeleton />

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        <TableSkeleton rows={12} columns={4} />
      </div>
    </div>
  );
}
