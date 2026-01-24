'use client';

import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { AppHeader } from '@/components/layout/AppHeader';

export default function DashboardPage() {
  const router = useRouter();
  const { user } = useAuthStore();

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
              Welcome to MoneyMate!
            </h2>

            <div className="space-y-4">
              <div className="border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-900/30 p-4">
                <div className="flex">
                  <div className="flex-shrink-0">
                    <svg
                      className="h-5 w-5 text-blue-400"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-blue-700 dark:text-blue-300">
                      You are successfully authenticated! This is a protected route.
                    </p>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">User Information</h3>
                <dl className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Email</dt>
                    <dd className="text-sm text-gray-900 dark:text-gray-100">{user?.email}</dd>
                  </div>
                  {user?.firstName && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">First Name</dt>
                      <dd className="text-sm text-gray-900 dark:text-gray-100">{user.firstName}</dd>
                    </div>
                  )}
                  {user?.lastName && (
                    <div>
                      <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Last Name</dt>
                      <dd className="text-sm text-gray-900 dark:text-gray-100">{user.lastName}</dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Auth Provider</dt>
                    <dd className="text-sm text-gray-900 dark:text-gray-100 capitalize">{user?.authProvider}</dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500 dark:text-gray-400">Account Status</dt>
                    <dd className="text-sm text-gray-900 dark:text-gray-100">
                      {user?.isActive ? (
                        <span className="text-green-600 dark:text-green-400">Active</span>
                      ) : (
                        <span className="text-red-600 dark:text-red-400">Inactive</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Quick Actions</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <button
                    onClick={() => router.push('/transactions')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-blue-600 dark:text-blue-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Transactions</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">Manage income & expenses</span>
                  </button>

                  <button
                    onClick={() => router.push('/accounts')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-green-600 dark:text-green-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Accounts</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">View all accounts</span>
                  </button>

                  <button
                    onClick={() => router.push('/budgets')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-purple-600 dark:text-purple-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Budgets</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">Track spending goals</span>
                  </button>

                  <button
                    onClick={() => router.push('/payees')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-orange-600 dark:text-orange-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Payees</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">Manage payees</span>
                  </button>

                  <button
                    onClick={() => router.push('/categories')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-indigo-600 dark:text-indigo-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Categories</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">Organize transactions</span>
                  </button>

                  <button
                    onClick={() => router.push('/bills')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-teal-600 dark:text-teal-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Bills & Deposits</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">Scheduled transactions</span>
                  </button>

                  <button
                    onClick={() => router.push('/reports')}
                    className="flex flex-col items-center justify-center p-6 bg-white dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-600 rounded-lg hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md transition-all"
                  >
                    <svg
                      className="h-8 w-8 text-red-600 dark:text-red-400 mb-2"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                      />
                    </svg>
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Reports</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 mt-1">Financial insights</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
