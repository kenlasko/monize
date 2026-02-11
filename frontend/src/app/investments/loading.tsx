import { CardSkeleton, ChartSkeleton, PageHeaderSkeleton, TableSkeleton } from '@/components/ui/LoadingSkeleton';

export default function InvestmentsLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeaderSkeleton />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>

        {/* Holdings and Chart */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <TableSkeleton rows={6} columns={4} />
          <ChartSkeleton />
        </div>

        {/* Transactions Table */}
        <TableSkeleton rows={8} columns={6} />
      </div>
    </div>
  );
}
