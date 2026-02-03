import { PageHeaderSkeleton, Skeleton } from '@/components/ui/LoadingSkeleton';

export default function SettingsLoading() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <PageHeaderSkeleton />

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        <div className="max-w-2xl mx-auto">
          {/* Settings Sections */}
          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
            <Skeleton className="h-6 w-40 mb-6" />
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-10 w-48 rounded-md" />
              </div>
              <div className="flex justify-between items-center">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-10 w-48 rounded-md" />
              </div>
              <div className="flex justify-between items-center">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-10 w-48 rounded-md" />
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6">
            <Skeleton className="h-6 w-40 mb-6" />
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-12 rounded-full" />
              </div>
              <div className="flex justify-between items-center">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-12 rounded-full" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
