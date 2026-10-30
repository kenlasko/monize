import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/**
 * Uses the existing controls without saving demo records. Group selection is
 * explicit: routeMatch and isStepReachable handle Skip/Back when no group was
 * opened. The overview offers New Group in a modal, not a second detail route.
 */
export const SHARED_EXPENSES_TOUR: TourDefinition = {
  id: 'release-1.20.0/shared-expenses',
  area: 'transactions',
  version: '1.20',
  i18nPrefix: 'release.v1_20_0.sharedExpenses',
  requiresData: 'ownerView',
  steps: [
    { id: 'welcome', anchorId: null },
    {
      id: 'tools',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.navSharedExpenses,
      openToolsMenu: true,
      skipOnMobile: true,
      placement: 'bottom',
    },
    {
      id: 'newGroup',
      route: '/shared-expenses',
      anchorId: TOUR_ANCHORS.sharedNewGroup,
    },
    {
      id: 'chooseGroup',
      route: '/shared-expenses',
      anchorId: TOUR_ANCHORS.sharedGroupList,
      unobtrusive: true,
      placement: 'left',
      advance: { type: 'route', route: '/shared-expenses/' },
    },
    {
      id: 'expenses',
      route: '/shared-expenses',
      routeMatch: '/shared-expenses/',
      anchorId: TOUR_ANCHORS.sharedGroupActions,
    },
    {
      id: 'balances',
      route: '/shared-expenses',
      routeMatch: '/shared-expenses/',
      anchorId: TOUR_ANCHORS.sharedGroupTabs,
      allowInteraction: true,
    },
    { id: 'done', anchorId: null },
  ],
};
