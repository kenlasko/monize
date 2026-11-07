'use client';

import type { ComponentType, SVGProps } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChatBubbleLeftRightIcon,
  CommandLineIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  MapIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import { GITHUB_REPO_URL as REPO_URL } from '@/lib/github';
import { tourIdForHelpPage } from '@/lib/help-tours';
import { getTourById, INTRO_TOUR } from '@/lib/tours/registry';
import { isTourOfferable } from '@/lib/tours/requirements';
import { useHelpSearchStore } from '@/store/helpSearchStore';
import { useHelpShortcutsStore } from '@/store/helpShortcutsStore';
import { useHelpStore } from '@/store/helpStore';
import { useTourStore } from '@/store/tourStore';
import { useWhatsNewStore } from '@/store/whatsNewStore';
import { useTourRequirements } from './useTourRequirements';

type MenuIcon = ComponentType<SVGProps<SVGSVGElement>>;

export interface HelpMenuAction {
  key: string;
  label: string;
  onClick: () => void;
  Icon: MenuIcon;
}

export interface HelpMenuLink {
  key: string;
  label: string;
  href: string;
  Icon: MenuIcon;
}

export interface HelpMenuEntries {
  /** `null` on a screen `PageHeader` gave no `help` key, so it is never shown. */
  helpForPage: HelpMenuAction | null;
  /** Search help, keyboard shortcuts, take the tour, What's new, in menu order. */
  actions: HelpMenuAction[];
  /** Report an issue, Discussions: real external links, opened in a new tab. */
  links: HelpMenuLink[];
}

/**
 * Entries for the header Help menu (`HelpMenu`) and its phone twin
 * (`MobileNavDrawer`), so the two cannot drift apart.
 *
 * "Take the tour" starts the current page's tour when `lib/help-tours.ts`
 * maps one and this user can actually take it (`isTourOfferable`, the same
 * check the What's New offer list and the panel's own "Show me" use);
 * otherwise it falls back to the evergreen introduction tour, which has no
 * data requirement and is always offerable.
 */
export function useHelpMenuEntries(): HelpMenuEntries {
  const t = useTranslations('help.menu');
  const contextPage = useHelpStore((s) => s.contextPage);

  const mappedTour = contextPage
    ? getTourById(tourIdForHelpPage(contextPage) ?? '')
    : undefined;
  const requirements = useTourRequirements(
    !!mappedTour?.requiresData || !!INTRO_TOUR.requiresData,
  );
  const tour =
    mappedTour && isTourOfferable(mappedTour, requirements)
      ? mappedTour
      : isTourOfferable(INTRO_TOUR, requirements)
        ? INTRO_TOUR
        : undefined;

  const helpForPage: HelpMenuAction | null = contextPage
    ? {
        key: 'helpForPage',
        label: t('helpForPage'),
        onClick: () => useHelpStore.getState().openAt({ page: contextPage }),
        Icon: InformationCircleIcon,
      }
    : null;

  const actions: HelpMenuAction[] = [
    {
      key: 'search',
      label: t('search'),
      onClick: () => useHelpSearchStore.getState().openSearch(),
      Icon: MagnifyingGlassIcon,
    },
    {
      key: 'shortcuts',
      label: t('shortcuts'),
      onClick: () => useHelpShortcutsStore.getState().openShortcuts(),
      Icon: CommandLineIcon,
    },
    // Omitted rather than offering a tour this user cannot complete, same
    // as the panel's own "Show me" and the What's New offer list.
    ...(tour
      ? [
          {
            key: 'takeTour',
            label: t('takeTour'),
            onClick: () => useTourStore.getState().startTour(tour),
            Icon: MapIcon,
          },
        ]
      : []),
    {
      key: 'whatsNew',
      label: t('whatsNew'),
      onClick: () => useWhatsNewStore.getState().open(),
      Icon: SparklesIcon,
    },
  ];

  const links: HelpMenuLink[] = [
    {
      key: 'reportIssue',
      label: t('reportIssue'),
      href: `${REPO_URL}/issues/new`,
      Icon: ExclamationTriangleIcon,
    },
    {
      key: 'discussions',
      label: t('discussions'),
      href: `${REPO_URL}/discussions`,
      Icon: ChatBubbleLeftRightIcon,
    },
  ];

  return { helpForPage, actions, links };
}
