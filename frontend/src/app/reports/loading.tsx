import { ChartSkeleton, PageHeaderSkeleton, Skeleton } from '@/components/ui/LoadingSkeleton';

export default function ReportsLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="px-4 sm:px-6 lg:px-12 py-8">
        <PageHeaderSkeleton />
        {/* Report Type Selection */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
          <Skeleton className="h-6 w-32 mb-4" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Skeleton className="h-24 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
          </div>
        </div>

        {/* Report Content */}
        <ChartSkeleton />
      </div>
    </div>
  );
}
