'use client';

import { useMemo, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowsRightLeftIcon,
  BookOpenIcon,
  CommandLineIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import { PayeeLogo } from '@/components/payees/PayeeLogo';
import { builtInReports } from '@/components/reports/report-definitions';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  navigateToTransactionSearch,
} from '@/hooks/useTransactionFilters';
import { useVisibleNavLinks } from '@/hooks/useVisibleNavLinks';
import {
  COMMAND_GROUPS,
  commandTerms,
  daysUntil,
  topMatches,
  type CommandGroup,
} from '@/lib/command-palette';
import { ownBalance } from '@/lib/logical-accounts';
import { ADMIN_LINKS, NAV_ICONS } from '@/lib/nav-links';
import { nextOccurrenceDueDate, nextOccurrenceEffectiveAmount } from '@/lib/scheduled-effective-amount';
import { SETTINGS_SECTION_IDS } from '@/lib/settings-sections';
import { buildTransactionsHref } from '@/lib/transactions-href';
import { useAuthStore } from '@/store/authStore';
import { useCommandPaletteStore } from '@/store/commandPaletteStore';
import { useDemoStore } from '@/store/demoStore';
import { useHelpSearchStore } from '@/store/helpSearchStore';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';
import { useHelpStore } from '@/store/helpStore';
import { useCommandPaletteData, useCommandPaletteSearch } from './useCommandPaletteData';

const GROUP_LIMIT = 5;
const PAGE_LIMIT = 8;

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

export interface CommandItem {
  id: string;
  group: CommandGroup;
  label: string;
  detail?: string;
  trailing?: string;
  visual: ReactNode;
  /** Shown on the row and run by Alt+N from anywhere in the box. */
  shortcut?: 'Alt+N';
  run: () => void;
}

const TILE_TONES = {
  gray: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300',
  blue: 'bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-300',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300',
  purple: 'bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300',
} as const;

function Tile({ icon: TileIcon, tone = 'gray' }: { icon?: Icon; tone?: keyof typeof TILE_TONES }) {
  return (
    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${TILE_TONES[tone]}`}>
      {TileIcon && <TileIcon className="h-4 w-4" aria-hidden="true" />}
    </span>
  );
}

/** Every result for `query`, grouped and in draw order, plus its load state. */
export function useCommandItems(query: string) {
  const t = useTranslations('navigation.commandPalette');
  const tNav = useTranslations('navigation');
  const tSettings = useTranslations('settings.nav');
  const tReportNames = useTranslations('reportNames');
  const router = useRouter();
  const pathname = usePathname();
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const today = useFinancialToday();

  const { isDelegateView, visibleNavLinks, visibleToolsLinks, visibleAiLinks, showAiMenu } =
    useVisibleNavLinks();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin') && !isDelegateView;
  const isDemoMode = useDemoStore((s) => s.isDemoMode);

  const reachable = useMemo(
    () => new Set([...visibleNavLinks, ...visibleToolsLinks].map((l) => l.href)),
    [visibleNavLinks, visibleToolsLinks],
  );
  const canSearchTransactions = reachable.has('/transactions');
  const { data, loading, failed: loadFailed } = useCommandPaletteData(reachable);
  const remote = useCommandPaletteSearch(query, canSearchTransactions);

  const items = useMemo(() => {
    const terms = commandTerms(query);
    const searching = terms.length > 0;
    const go = (href: string) => () => router.push(href);
    const pair = (first: string, second?: string | null) =>
      second ? t('detailPair', { first, second }) : first;
    const results: CommandItem[] = [];

    for (const account of topMatches(data.accounts, (a) => `${a.name} ${a.institution ?? ''}`, terms, GROUP_LIMIT)) {
      results.push({
        id: `account:${account.id}`,
        group: 'accounts',
        label: account.name,
        detail: account.institution ?? undefined,
        // A brokerage's stored balance is always zero and its worth needs the
        // portfolio, which the palette does not load: no figure beats a wrong one.
        trailing:
          account.accountSubType === 'INVESTMENT_BROKERAGE'
            ? undefined
            : formatCurrency(ownBalance(account), account.currencyCode),
        visual: <Tile icon={NAV_ICONS['/accounts']} tone="blue" />,
        run: go(`/accounts/${account.id}`),
      });
    }

    const payees = topMatches(data.payees, (p) => p.name, terms, GROUP_LIMIT);
    for (const payee of payees) {
      results.push({
        id: `payee:${payee.id}`,
        group: 'payees',
        label: payee.name,
        detail:
          payee.transactionCount == null
            ? payee.defaultCategory?.name
            : pair(t('transactionCount', { count: payee.transactionCount }), payee.defaultCategory?.name),
        visual: <PayeeLogo payee={payee} size={32} />,
        run: go(`/payees/${payee.id}`),
      });
    }

    for (const category of topMatches(data.categories, (c) => c.name, terms, GROUP_LIMIT)) {
      results.push({
        id: `category:${category.id}`,
        group: 'categories',
        label: category.name,
        visual: (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center">
            <CategoryGlyph icon={category.effectiveIcon} color={category.effectiveColor} size={20} />
          </span>
        ),
        run: go(`/categories/${category.id}`),
      });
    }

    for (const bill of topMatches(data.bills.filter((b) => b.isActive), (b) => b.name, terms, GROUP_LIMIT)) {
      const { amount, currencyCode } = nextOccurrenceEffectiveAmount(bill);
      const days = daysUntil(nextOccurrenceDueDate(bill), today);
      results.push({
        id: `bill:${bill.id}`,
        group: 'bills',
        label: bill.name,
        detail: pair(days < 0 ? t('overdue', { days: -days }) : t('dueIn', { days }), bill.account?.name),
        trailing: amount === null ? undefined : formatCurrency(Math.abs(amount), currencyCode),
        visual: <Tile icon={NAV_ICONS['/bills']} tone="amber" />,
        run: go('/bills'),
      });
    }

    for (const security of topMatches(data.securities, (s) => `${s.symbol} ${s.name}`, terms, GROUP_LIMIT)) {
      results.push({
        id: `security:${security.id}`,
        group: 'securities',
        label: security.symbol,
        detail: security.name,
        visual: <Tile icon={NAV_ICONS['/securities']} />,
        run: go(`/securities/${security.id}`),
      });
    }

    if (reachable.has('/reports')) {
      const reports = [
        ...builtInReports.map((r) => ({
          id: r.id,
          name: tReportNames(r.id as Parameters<typeof tReportNames>[0]),
        })),
        ...data.customReports.map((r) => ({ id: `custom/${r.id}`, name: r.name })),
        ...data.investmentReports.map((r) => ({ id: `investment/${r.id}`, name: r.name })),
      ];
      for (const report of topMatches(reports, (r) => r.name, terms, GROUP_LIMIT)) {
        results.push({
          id: `report:${report.id}`,
          group: 'reports',
          label: report.name,
          visual: <Tile icon={NAV_ICONS['/reports']} tone="purple" />,
          run: go(`/reports/${report.id}`),
        });
      }
    }

    const mainPages = [{ href: '/dashboard', labelKey: 'dashboard' }, ...visibleNavLinks];
    const settingsPage = { href: '/settings', label: tNav('settings') };
    const toPage = (l: { href: string; labelKey: string }) => ({ href: l.href, label: tNav(l.labelKey) });
    if (searching) {
      const pages = [
        ...mainPages.map(toPage),
        ...visibleToolsLinks.map(toPage),
        ...(showAiMenu ? visibleAiLinks.map(toPage) : []),
        ...(isAdmin ? ADMIN_LINKS.map(toPage) : []),
        settingsPage,
        // Delegates get a Security-only Settings, so its sections are the owner's.
        ...(isDelegateView
          ? []
          : SETTINGS_SECTION_IDS.filter((s) => !isDemoMode || s.demoVisible).map((s) => ({
              href: 'href' in s ? s.href : `/settings#${s.id}`,
              label: tSettings(s.navKey),
            }))),
      ];
      // A route can be both a menu entry and a Settings link; a row id is its href.
      const uniquePages = [...new Map(pages.map((p) => [p.href, p])).values()];
      for (const page of topMatches(uniquePages, (p) => p.label, terms, PAGE_LIMIT)) {
        results.push(pageItem(page, go(page.href)));
      }
    } else {
      for (const page of [...mainPages.map(toPage), settingsPage]) {
        results.push(pageItem(page, go(page.href)));
      }
    }

    for (const transaction of remote.transactions) {
      results.push({
        id: `transaction:${transaction.id}`,
        group: 'transactions',
        label: transaction.payeeName || transaction.description || t('noPayee'),
        detail: pair(formatDate(transaction.transactionDate), transaction.account?.name),
        trailing: formatCurrency(transaction.amount, transaction.currencyCode),
        visual: <Tile icon={ListBulletIcon} />,
        run: go(buildTransactionsHref({ targetTransactionId: transaction.id })),
      });
    }

    for (const hit of remote.help) {
      results.push({
        id: `help:${hit.page}#${hit.section ?? ''}`,
        group: 'help',
        label: hit.heading || hit.pageTitle,
        detail: hit.heading && hit.heading !== hit.pageTitle ? hit.pageTitle : undefined,
        visual: <Tile icon={BookOpenIcon} />,
        run: () => useHelpStore.getState().openAt({ page: hit.page, section: hit.section ?? undefined }),
      });
    }

    // The best-matching payee gets the actions a reader came for; the plain
    // "New transaction" gives up Alt+N to it rather than sharing the key.
    const payee = canSearchTransactions ? payees[0] : undefined;
    const requestNew = useCommandPaletteStore.getState().requestNewTransaction;
    // Already there, the page answers the request itself; a push would stack
    // on the form's own history entry and drop the filters from the URL.
    const goToRegister = () => {
      if (pathname !== '/transactions') router.push('/transactions');
    };
    if (payee) {
      results.push(
        {
          id: `action:new-for:${payee.id}`,
          group: 'actions',
          label: t('newTransactionFor', { name: payee.name }),
          visual: <Tile icon={PlusIcon} tone="blue" />,
          shortcut: 'Alt+N',
          run: () => {
            requestNew({ id: payee.id, name: payee.name, defaultCategoryId: payee.defaultCategoryId });
            goToRegister();
          },
        },
        {
          id: `action:transactions-for:${payee.id}`,
          group: 'actions',
          label: t('transactionsFor', { name: payee.name }),
          visual: <Tile icon={ArrowsRightLeftIcon} tone="purple" />,
          // Singular `payeeId`: the parameter the Transactions page also
          // honours on a soft navigation, when it is already mounted.
          run: go(`/transactions?payeeId=${payee.id}`),
        },
      );
    }
    if (searching && canSearchTransactions) {
      results.push({
        id: 'action:search-transactions',
        group: 'actions',
        label: t('searchTransactions', { query }),
        visual: <Tile icon={MagnifyingGlassIcon} tone="blue" />,
        run: () => navigateToTransactionSearch(query, router.push),
      });
    }
    const staticActions: CommandItem[] = [
      ...(canSearchTransactions
        ? [
            {
              id: 'action:new-transaction',
              group: 'actions' as const,
              label: t('newTransaction'),
              visual: <Tile icon={PlusIcon} tone="blue" />,
              shortcut: payee ? undefined : ('Alt+N' as const),
              run: () => {
                requestNew();
                goToRegister();
              },
            },
          ]
        : []),
      {
        id: 'action:search-help',
        group: 'actions',
        label: t('searchHelp'),
        visual: <Tile icon={BookOpenIcon} />,
        run: () => useHelpSearchStore.getState().openSearch(),
      },
      {
        id: 'action:shortcuts',
        group: 'actions',
        label: t('keyboardShortcuts'),
        visual: <Tile icon={CommandLineIcon} />,
        run: () => useHelpShortcutsStore.getState().openShortcuts(),
      },
    ];
    results.push(...(searching ? topMatches(staticActions, (a) => a.label, terms, GROUP_LIMIT) : staticActions));

    return COMMAND_GROUPS.flatMap((group) => results.filter((item) => item.group === group));
  }, [
    query, data, remote.transactions, remote.help, reachable, canSearchTransactions, visibleNavLinks,
    visibleToolsLinks, visibleAiLinks, showAiMenu, isAdmin, isDelegateView, isDemoMode, today, router, pathname,
    formatCurrency, formatDate, t, tNav, tSettings, tReportNames,
  ]);

  return {
    items,
    pending: loading || remote.pending,
    failed: loadFailed || remote.failed,
  };
}

function pageItem(page: { href: string; label: string }, run: () => void): CommandItem {
  // A settings anchor shares the Settings page's icon.
  const PageIcon = NAV_ICONS[page.href.split('#')[0]] ?? NAV_ICONS['/settings'];
  return {
    id: `page:${page.href}`,
    group: 'pages',
    label: page.label,
    visual: <Tile icon={PageIcon} />,
    run,
  };
}
