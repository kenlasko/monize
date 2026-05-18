'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/lib/auth';
import Image from 'next/image';
import { Button } from '@/components/ui/Button';
import { BudgetAlertBadge } from '@/components/budgets/BudgetAlertBadge';
import { ActionHistoryPanel } from '@/components/layout/ActionHistoryPanel';
import {
  HEADER_SEARCH_EVENT,
  clearTransactionFilterStorage,
  type HeaderSearchEventDetail,
} from '@/hooks/useTransactionFilters';
import toast from 'react-hot-toast';

const navLinks = [
  { href: '/transactions', label: 'Transactions' },
  { href: '/bills', label: 'Bills & Deposits' },
  { href: '/investments', label: 'Investments' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/budgets', label: 'Budgets' },
  { href: '/reports', label: 'Reports' },
];

const toolsLinks: { href: string; label: string; badge?: string }[] = [
  { href: '/categories', label: 'Categories' },
  { href: '/payees', label: 'Payees' },
  { href: '/tags', label: 'Tags' },
  { href: '/securities', label: 'Securities' },
  { href: '/currencies', label: 'Currencies' },
  { href: '/import', label: 'Import Transactions' },
];

const aiLinks: { href: string; label: string }[] = [
  { href: '/insights', label: 'Insights' },
  { href: '/ai', label: 'AI Assistant' },
];

export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout, actingAsUserId, delegateCapabilities } =
    useAuthStore();
  // Phase 1: a delegate acting as an owner only sees the Dashboard.
  const isDelegateView = !!actingAsUserId;
  const visibleNavLinks = isDelegateView ? [] : navLinks;
  // A delegate sees only the Tools sections they were granted manage
  // capability for (payees/categories/tags). Everyone else sees all.
  const toolsCapabilityByHref: Record<
    string,
    'payees' | 'categories' | 'tags'
  > = {
    '/categories': 'categories',
    '/payees': 'payees',
    '/tags': 'tags',
  };
  const visibleToolsLinks = isDelegateView
    ? toolsLinks.filter((l) => {
        const cap = toolsCapabilityByHref[l.href];
        return cap ? !!delegateCapabilities?.[cap] : false;
      })
    : toolsLinks;
  const [toolsOpen, setToolsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const toolsRef = useRef<HTMLDivElement>(null);
  const aiRef = useRef<HTMLDivElement>(null);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(event.target as Node)) {
        setToolsOpen(false);
      }
      if (aiRef.current && !aiRef.current.contains(event.target as Node)) {
        setAiOpen(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setMobileMenuOpen(false);
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus the search input as it slides open.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  const submitSearch = () => {
    const term = searchTerm.trim();
    if (!term) return;
    // Wipe persisted filters so the hook initializes clean (including
    // `accountStatus`, which is not represented in the URL).
    clearTransactionFilterStorage();
    // Notify a mounted Transactions page to reset and apply the term.
    const detail: HeaderSearchEventDetail = { term };
    window.dispatchEvent(new CustomEvent(HEADER_SEARCH_EVENT, { detail }));
    router.push(`/transactions?search=${encodeURIComponent(term)}`);
    setSearchOpen(false);
    setSearchTerm('');
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitSearch();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSearchOpen(false);
      setSearchTerm('');
    }
  };

  // Close mobile menu on route change (setState during render pattern)
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setMobileMenuOpen(false);
  }

  const isToolsActive = toolsLinks.some((link) => pathname === link.href);
  const isAiActive = aiLinks.some((link) => pathname === link.href);

  const handleLogout = async () => {
    try {
      await authApi.logout();
      logout();
      toast.success('Logged out successfully');
      router.push('/login');
    } catch {
      logout();
      router.push('/login');
    }
  };

  return (
    <header className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50">
      <div className="px-4 sm:px-6 lg:px-12">
        <div className="flex justify-between h-16">
          <div className="flex items-center">
            {/* Mobile hamburger menu button */}
            <div className="relative lg:hidden" ref={mobileMenuRef}>
              <button
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                className="p-2 mr-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
                aria-label="Toggle menu"
              >
                {mobileMenuOpen ? (
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                )}
              </button>

              {/* Mobile menu dropdown */}
              {mobileMenuOpen && (
                <div className="absolute left-0 top-full mt-1 w-56 bg-white dark:bg-gray-800 rounded-md shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50">
                  <div className="py-1">
                    {/* Dashboard link */}
                    <button
                      onClick={() => router.push('/dashboard')}
                      className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                        pathname === '/dashboard'
                          ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                          : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                      }`}
                    >
                      Dashboard
                    </button>

                    {/* Main nav links */}
                    {visibleNavLinks.map((link) => (
                      <button
                        key={link.href}
                        onClick={() => router.push(link.href)}
                        className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                          pathname === link.href
                            ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        {link.label}
                      </button>
                    ))}

                    {!isDelegateView && (
                    <>
                    {/* Divider */}
                    <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

                    {/* AI section header */}
                    <div className="px-4 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      AI
                    </div>

                    {/* AI links */}
                    {aiLinks.map((link) => (
                      <button
                        key={link.href}
                        onClick={() => router.push(link.href)}
                        className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                          pathname === link.href
                            ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        {link.label}
                      </button>
                    ))}
                    </>
                    )}

                    {visibleToolsLinks.length > 0 && (
                    <>
                    {/* Divider */}
                    <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

                    {/* Tools section header */}
                    <div className="px-4 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                      Tools
                    </div>

                    {/* Tools links */}
                    {visibleToolsLinks.map((link) => (
                      <button
                        key={link.href}
                        onClick={() => router.push(link.href)}
                        className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                          pathname === link.href
                            ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                        }`}
                      >
                        {link.label}
                        {link.badge && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                            {link.badge}
                          </span>
                        )}
                      </button>
                    ))}
                    </>
                    )}

                    {/* Admin section - only for admins */}
                    {!isDelegateView && user?.role === 'admin' && (
                      <>
                        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />
                        <div className="px-4 py-1 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Admin
                        </div>
                        <button
                          onClick={() => router.push('/admin/users')}
                          className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                            pathname.startsWith('/admin')
                              ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          User Management
                        </button>
                      </>
                    )}

                    {/* Divider */}
                    {!isDelegateView && (
                      <>
                        <div className="border-t border-gray-200 dark:border-gray-700 my-1" />

                        {/* Settings link */}
                        <button
                          onClick={() => router.push('/settings')}
                          className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                            pathname === '/settings'
                              ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          Settings
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => router.push('/dashboard')}
              className="hidden lg:flex items-center gap-2 text-2xl font-bold text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              <Image src="/icons/monize-logo.svg" alt="Monize" width={32} height={32} className="rounded" priority />
              <span className="hidden lg:inline">Monize</span>
            </button>
            {(!isDelegateView || visibleToolsLinks.length > 0) && (
            <nav className="hidden lg:ml-8 lg:flex lg:items-center lg:space-x-4">
              {visibleNavLinks.map((link) => (
                <button
                  key={link.href}
                  onClick={() => router.push(link.href)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    pathname === link.href
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  {link.label}
                </button>
              ))}

              {!isDelegateView && (
              <>
              {/* AI Dropdown */}
              <div className="relative" ref={aiRef}>
                <button
                  onClick={() => setAiOpen(!aiOpen)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1 ${
                    isAiActive
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  AI
                  <svg
                    className={`w-4 h-4 transition-transform ${aiOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {aiOpen && (
                  <div className="absolute left-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50">
                    <div className="py-1">
                      {aiLinks.map((link) => (
                        <button
                          key={link.href}
                          onClick={() => {
                            router.push(link.href);
                            setAiOpen(false);
                          }}
                          className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                            pathname === link.href
                              ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {link.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              </>
              )}

              {visibleToolsLinks.length > 0 && (
              <>
              {/* Tools Dropdown */}
              <div className="relative" ref={toolsRef}>
                <button
                  onClick={() => setToolsOpen(!toolsOpen)}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors inline-flex items-center gap-1 ${
                    isToolsActive
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  Tools
                  <svg
                    className={`w-4 h-4 transition-transform ${toolsOpen ? 'rotate-180' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {toolsOpen && (
                  <div className="absolute left-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-md shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-50">
                    <div className="py-1">
                      {visibleToolsLinks.map((link) => (
                        <button
                          key={link.href}
                          onClick={() => {
                            router.push(link.href);
                            setToolsOpen(false);
                          }}
                          className={`block w-full text-left px-4 py-2 text-sm transition-colors ${
                            pathname === link.href
                              ? 'bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-200'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                        >
                          {link.label}
                          {link.badge && (
                            <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
                              {link.badge}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              </>
              )}

              {/* Admin link - only visible to admins */}
              {!isDelegateView && user?.role === 'admin' && (
                <button
                  onClick={() => router.push('/admin/users')}
                  className={`px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                    pathname.startsWith('/admin')
                      ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                      : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
                  }`}
                >
                  Admin
                </button>
              )}
            </nav>
            )}
          </div>
          <div className="flex items-center space-x-1 sm:space-x-4">
            <div className="relative" ref={searchRef}>
              <div className="flex items-center">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search transactions..."
                  aria-label="Search transactions"
                  aria-hidden={!searchOpen}
                  tabIndex={searchOpen ? 0 : -1}
                  className={`overflow-hidden transition-all duration-200 ease-out rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    searchOpen
                      ? 'w-44 sm:w-64 px-3 py-1.5 mr-1 opacity-100'
                      : 'w-0 px-0 py-1.5 border-transparent opacity-0 pointer-events-none'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (searchOpen) {
                      submitSearch();
                    } else {
                      setSearchOpen(true);
                    }
                  }}
                  aria-label={searchOpen ? 'Search' : 'Open search'}
                  title="Search transactions"
                  className="p-2 rounded-md text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="w-5 h-5"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <ActionHistoryPanel />
            <BudgetAlertBadge />
            {!isDelegateView && (
            <button
              onClick={() => router.push('/settings')}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                pathname === '/settings'
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-200'
                  : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title="Settings"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.5}
                stroke="currentColor"
                className="w-5 h-5"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                />
              </svg>
              <span className="hidden sm:inline">{user?.firstName || user?.email}</span>
            </button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
            >
              Logout
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
