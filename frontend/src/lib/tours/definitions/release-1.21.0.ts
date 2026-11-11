import { TOUR_ANCHORS } from '../anchors';
import type { TourDefinition } from '../types';

/** Minor line these tours belong to; matched against the running major.minor. */
export const RELEASE_1_21_MINOR = '1.21';

/**
 * The command palette: Ctrl/Cmd+K, one box over the reader's data, the app's
 * screens and the guide.
 *
 * **The reader opens it.** The palette has no button, only the shortcut, so
 * the step that asks for it is an anchorless coach mark that advances once the
 * palette's box appears. The steps inside it are `skipOnBack`: once it closes,
 * Back must not land on an anchor that went with it.
 *
 * **Closed with its own esc button, not the Esc key.** The tour claims Escape
 * in the capture phase to end itself, so the key would end the tour rather
 * than close the palette; the copy names the button.
 *
 * **Keyboard only, so desktop only.** Every step that needs the palette is
 * `skipOnMobile`; on a phone the tour is its welcome and its closing card,
 * which points at the header's search instead.
 *
 * The palette steps carry `route: '/dashboard'` so the reader opens it on a
 * plain page: over a dialog (the What's New window the tour may be launched
 * from) the shortcut opens guide search instead.
 */
export const RELEASE_1_21_COMMAND_PALETTE_TOUR: TourDefinition = {
  id: 'release-1.21.0/command-palette',
  area: 'intro',
  version: RELEASE_1_21_MINOR,
  i18nPrefix: 'release.v1_21_0.commandPalette',
  docs: 'commandPalette',
  steps: [
    {
      // Route-agnostic welcome: shows wherever the tour was launched, so it
      // never fights a closing What's New modal's history.back().
      id: 'welcome',
      anchorId: null,
    },
    {
      id: 'openPalette',
      route: '/dashboard',
      anchorId: null,
      unobtrusive: true,
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.commandPaletteInput },
      skipOnMobile: true,
    },
    {
      // Passive, but the box stays usable so the reader can type while reading.
      id: 'searchBox',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.commandPaletteInput,
      allowInteraction: true,
      placement: 'auto',
      skipOnBack: true,
      skipOnMobile: true,
    },
    {
      id: 'results',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.commandPaletteResults,
      allowInteraction: true,
      placement: 'auto',
      skipOnBack: true,
      skipOnMobile: true,
    },
    {
      id: 'closePalette',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.commandPaletteClose,
      placement: 'auto',
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.commandPaletteInput },
      skipOnBack: true,
      skipOnMobile: true,
    },
    {
      id: 'done',
      anchorId: null,
    },
  ],
};

/**
 * In-app help: the user guide in a panel beside the page, the header's Help
 * menu, and the Learn more links on the page itself.
 *
 * **The reader opens the panel** from the ? beside a page title (Transactions,
 * which always has one), and the tour advances once the panel appears. The
 * panel steps are `skipOnBack` and interactive enough to read: the panel step
 * keeps it scrollable, and the toolbar step advances when the reader closes it
 * with the toolbar's own Close, which is how the tour leaves it. The Esc key
 * would end the tour first, so the copy names the button.
 *
 * The Help menu is `hidden sm:block` (a phone has the same entries in the
 * drawer, which carries no anchors), so that step is `skipOnMobile`.
 */
export const RELEASE_1_21_IN_APP_HELP_TOUR: TourDefinition = {
  id: 'release-1.21.0/in-app-help',
  area: 'intro',
  version: RELEASE_1_21_MINOR,
  i18nPrefix: 'release.v1_21_0.inAppHelp',
  docs: 'helpInApp',
  steps: [
    {
      id: 'welcome',
      anchorId: null,
    },
    {
      id: 'pageHelp',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.pageHelpButton,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.helpPanel },
    },
    {
      id: 'panel',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.helpPanel,
      allowInteraction: true,
      placement: 'auto',
      skipOnBack: true,
    },
    {
      id: 'panelControls',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.helpPanelToolbar,
      placement: 'auto',
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.helpPanel },
      skipOnBack: true,
    },
    {
      id: 'helpMenu',
      route: '/transactions',
      anchorId: TOUR_ANCHORS.helpMenuButton,
      placement: 'bottom',
      skipOnMobile: true,
    },
    {
      // Learn more links sit on tooltips and empty screens all over the app;
      // describe them rather than anchor one of many.
      id: 'learnMore',
      route: '/transactions',
      anchorId: null,
      unobtrusive: true,
    },
    {
      id: 'done',
      anchorId: null,
    },
  ],
};

/**
 * Dashboard edit mode: the gear beside the greeting arranges the widgets on
 * the dashboard itself, saved only on Done.
 *
 * **The reader enters edit mode** with the gear, and the tour advances once the
 * edit bar appears. The steps inside edit mode are `skipOnBack`. The grid step
 * keeps the widgets usable so the reader can try a drag or a resize while the
 * card explains them; the last edit-mode step advances when the bar goes away,
 * whichever of Done or Cancel the reader chooses. The Esc key would end the
 * tour before it cancels edit mode, so the copy names the buttons.
 *
 * **Gated on `ownerView`.** A delegate's dashboard has no gear.
 */
export const RELEASE_1_21_DASHBOARD_EDIT_TOUR: TourDefinition = {
  id: 'release-1.21.0/dashboard-edit',
  area: 'intro',
  version: RELEASE_1_21_MINOR,
  i18nPrefix: 'release.v1_21_0.dashboardEdit',
  requiresData: 'ownerView',
  docs: 'dashboardEditMode',
  steps: [
    {
      id: 'welcome',
      anchorId: null,
    },
    {
      id: 'enterEdit',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardCustomize,
      placement: 'bottom',
      advance: { type: 'appear', anchorId: TOUR_ANCHORS.dashboardEditBar },
    },
    {
      id: 'editBar',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardEditBar,
      placement: 'bottom',
      skipOnBack: true,
    },
    {
      id: 'arrange',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardWidgets,
      unobtrusive: true,
      allowInteraction: true,
      placement: 'auto',
      skipOnBack: true,
    },
    {
      id: 'finish',
      route: '/dashboard',
      anchorId: TOUR_ANCHORS.dashboardEditActions,
      placement: 'bottom',
      advance: { type: 'disappear', anchorId: TOUR_ANCHORS.dashboardEditBar },
      skipOnBack: true,
    },
    {
      id: 'done',
      anchorId: null,
    },
  ],
};

export const RELEASE_1_21_TOURS: readonly TourDefinition[] = [
  RELEASE_1_21_COMMAND_PALETTE_TOUR,
  RELEASE_1_21_IN_APP_HELP_TOUR,
  RELEASE_1_21_DASHBOARD_EDIT_TOUR,
];
