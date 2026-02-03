import { CardSkeleton, PageHeaderSkeleton, TableSkeleton } from '@/components/ui/LoadingSkeleton';

export default function AccountsLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <PageHeaderSkeleton />

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>

        {/* Accounts Table */}
        <TableSkeleton rows={8} columns={5} />
      </div>
    </div>
  );
}
