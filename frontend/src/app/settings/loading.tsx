import { PageHeaderSkeleton, Skeleton } from '@/components/ui/LoadingSkeleton';

/**
 * The frame of the Settings page (`page.tsx`): the same `max-w-6xl` width,
 * the section sidebar from `lg:` up and the content column beside it, so the
 * page does not change width when it replaces this skeleton.
 */
export default function SettingsLoading() {
  return (
    <div className="page-ambient-glow min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeaderSkeleton />
        <div className="lg:flex lg:gap-10">
          <div className="hidden lg:block lg:w-52 shrink-0 space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex-1 min-w-0">
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
    </div>
  );
}
