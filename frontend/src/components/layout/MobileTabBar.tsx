'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { Bars3Icon, PlusIcon } from '@heroicons/react/24/outline';
import { useMobileTabs, type MobileTab } from '@/hooks/useMobileTabs';
import { isNavSectionActive } from '@/lib/nav-section';
import { isPublicPath } from '@/lib/public-paths';
import { useAuthStore } from '@/store/authStore';
import { startNewTransaction, useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useMobileChromeStore } from '@/store/mobileChromeStore';

const TAB_CLASS =
  'flex min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500';
const TAB_ACTIVE_CLASS = 'text-blue-600 dark:text-blue-400';
const TAB_IDLE_CLASS =
  'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100';

/**
 * The app's navigation below `xl`: up to three tabs the reader chooses (Settings
 * -> Preferences), the add button in the middle and More at the end. More is not
 * one of the choices because it is the way to everything the bar leaves out.
 *
 * The five columns stay put however few tabs are chosen, so the add button is
 * always centred and More always last; the chosen tabs fill from the left. Fixed
 * here rather than inside `AppHeader`, whose transform would capture it.
 *
 * Not drawn signed out: the shell also mounts on some public routes, where every
 * tab would bounce to the login screen and the add button would leave a request
 * waiting to open a form after sign-in.
 */
export function MobileTabBar() {
  const t = useTranslations('navigation');
  const tPalette = useTranslations('navigation.commandPalette');
  const router = useRouter();
  const pathname = usePathname();
  const { tabs, canAddTransaction } = useMobileTabs();
  const drawerOpen = useMobileChromeStore((s) => s.drawerOpen);
  const toggleDrawer = useMobileChromeStore((s) => s.toggleDrawer);
  const clearNewTransactionRequest = useCommandPaletteStore(
    (s) => s.clearNewTransactionRequest,
  );
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (!isAuthenticated || isPublicPath(pathname)) return null;

  const isActive = (tab: MobileTab) => isNavSectionActive(pathname, tab.href);
  // A page the bar has no tab for belongs to More, so the bar still says where
  // the reader is.
  const moreActive = drawerOpen || !tabs.some(isActive);

  const renderTab = (tab: MobileTab | undefined) => {
    if (!tab) return <span aria-hidden="true" />;
    const active = isActive(tab);
    const Icon = tab.icon;
    return (
      <button
        type="button"
        onClick={() => {
          clearNewTransactionRequest();
          // Already here: a push would drop the page's filters from the URL and
          // leave a Back press that appears to do nothing.
          if (pathname !== tab.href) router.push(tab.href);
        }}
        aria-current={active ? 'page' : undefined}
        className={`${TAB_CLASS} ${active ? TAB_ACTIVE_CLASS : TAB_IDLE_CLASS}`}
      >
        <Icon aria-hidden className="h-6 w-6 flex-shrink-0" />
        <span className="max-w-full truncate">{t(tab.labelKey)}</span>
      </button>
    );
  };

  return (
    <nav
      aria-label={t('tabBar')}
      data-testid="mobile-tab-bar"
      data-mobile-tab-bar=""
      className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200/80 bg-white pb-[env(safe-area-inset-bottom)] xl:hidden print:hidden dark:border-white/5 dark:bg-gray-800 supports-[backdrop-filter]:bg-white/75 supports-[backdrop-filter]:backdrop-blur-md supports-[backdrop-filter]:backdrop-saturate-150 supports-[backdrop-filter]:dark:bg-gray-800/70"
    >
      <div className="grid h-16 grid-cols-5">
        {renderTab(tabs[0])}
        {renderTab(tabs[1])}
        {canAddTransaction ? (
          <div className="flex items-start justify-center">
            <button
              type="button"
              onClick={() => startNewTransaction(pathname, router.push)}
              aria-label={tPalette('newTransaction')}
              className="-mt-5 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 motion-reduce:transition-none dark:focus-visible:ring-offset-gray-900"
            >
              <PlusIcon aria-hidden className="h-7 w-7" />
            </button>
          </div>
        ) : (
          <span aria-hidden="true" />
        )}
        {renderTab(tabs[2])}
        <button
          type="button"
          onClick={toggleDrawer}
          aria-expanded={drawerOpen}
          className={`${TAB_CLASS} ${moreActive ? TAB_ACTIVE_CLASS : TAB_IDLE_CLASS}`}
        >
          <Bars3Icon aria-hidden className="h-6 w-6 flex-shrink-0" />
          <span className="max-w-full truncate">{t('more')}</span>
        </button>
      </div>
    </nav>
  );
}
